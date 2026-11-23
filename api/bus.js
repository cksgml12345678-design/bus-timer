// api/bus.js
const routeStopCache = new Map();
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 메모리 캐시

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const rawKey = (process.env.TAGO_API_KEY || '').trim();
  if (!rawKey) {
    return res.status(500).json({
      error: 'Vercel 환경변수(TAGO_API_KEY)가 설정되지 않았습니다.'
    });
  }

  const serviceKey = rawKey.includes('%') ? rawKey : encodeURIComponent(rawKey);

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = Math.min(Math.max(parseInt(req.query.radius, 10) || 250, 100), 1500);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: '위치 좌표(lat, lng)가 올바르지 않습니다.' });
  }

  async function fetchTago(url) {
    const response = await fetch(url);
    const text = await response.text();

    if (text.trim().startsWith('<')) {
      const msgMatch = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/);
      const authMsg = msgMatch ? msgMatch[1] : 'API 인증 오류';
      throw new Error(`공공데이터 응답 오류(${authMsg}): 승인 직후라면 최대 1시간 뒤 자동 활성화됩니다.`);
    }

    const data = JSON.parse(text);
    const code = data?.response?.header?.resultCode;
    if (code && code !== '00') {
      throw new Error(`공공데이터 오류(${code}): ${data?.response?.header?.resultMsg || ''}`);
    }

    const item = data?.response?.body?.items?.item;
    if (!item) return [];
    return Array.isArray(item) ? item : [item];
  }

  function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  async function getRouteStops(cityCode, routeId) {
    const cacheKey = `${cityCode}:${routeId}`;
    const cached = routeStopCache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < ROUTE_CACHE_TTL_MS) {
      return cached.stops;
    }

    try {
      const url =
        `https://apis.data.go.kr/1613000/BusRouteInfoInqireService/getRouteAcctoThrghSttnList` +
        `?serviceKey=${serviceKey}&cityCode=${encodeURIComponent(cityCode)}` +
        `&routeId=${encodeURIComponent(routeId)}&numOfRows=250&pageNo=1&_type=json`;

      const raw = await fetchTago(url);
      const stops = raw
        .map((x) => ({
          nodeId: String(x.nodeid || ''),
          name: String(x.nodenm || ''),
          ord: parseInt(x.nodeord, 10) || 0,
          lat: parseFloat(x.gpslati),
          lng: parseFloat(x.gpslong)
        }))
        .filter((x) => x.nodeId && !Number.isNaN(x.lat) && !Number.isNaN(x.lng))
        .sort((a, b) => a.ord - b.ord);

      if (stops.length > 0) {
        routeStopCache.set(cacheKey, { savedAt: Date.now(), stops });
      }
      return stops;
    } catch {
      // 노선 API가 아직 반영 전이어도 버스 도착 시간은 정상 표시되도록 예외 무시
      return null;
    }
  }

  function calcDirection(routeStops, currentNodeId) {
    if (!routeStops || routeStops.length < 2) {
      return { bearing: null, nextStop: '' };
    }

    const idx = routeStops.findIndex((s) => s.nodeId === currentNodeId);
    if (idx === -1) return { bearing: null, nextStop: '' };

    const curr = routeStops[idx];
    let target = routeStops[idx + 1];
    let nextStop = target ? target.name : '종점';
    let from = curr;
    let to = target;

    // 종점인 경우 직전 정류장에서 들어오는 방향을 사용
    if (!target) {
      from = routeStops[idx - 1];
      to = curr;
    } else if (
      Math.abs(to.lat - from.lat) < 0.00001 &&
      Math.abs(to.lng - from.lng) < 0.00001 &&
      routeStops[idx + 2]
    ) {
      to = routeStops[idx + 2];
    }

    if (!from || !to) return { bearing: null, nextStop };

    const dLat = to.lat - from.lat;
    const dLng = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180);
    if (Math.abs(dLat) < 1e-7 && Math.abs(dLng) < 1e-7) {
      return { bearing: null, nextStop };
    }

    // 북쪽=0도, 동쪽=90도, 남쪽=180도, 서쪽=270도 (시계 방향)
    const bearing = Math.round(((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360);
    return { bearing, nextStop };
  }

  try {
    // 1km 반경일 때는 동서남북 지점을 함께 조회해 바깥쪽 정류장까지 수집
    const queryPoints = [{ lat, lng }];
    if (radius > 500) {
      queryPoints.push(
        { lat: lat + 0.0048, lng },
        { lat: lat - 0.0048, lng },
        { lat, lng: lng + 0.006 },
        { lat, lng: lng - 0.006 }
      );
    }

    const stopResults = await Promise.allSettled(
      queryPoints.map((pt) => {
        const url =
          `https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList` +
          `?serviceKey=${serviceKey}&gpsLati=${pt.lat}&gpsLong=${pt.lng}&numOfRows=50&pageNo=1&_type=json`;
        return fetchTago(url);
      })
    );

    const fulfilled = stopResults.filter((r) => r.status === 'fulfilled');
    if (fulfilled.length === 0) {
      const firstErr = stopResults.find((r) => r.status === 'rejected');
      throw firstErr?.reason || new Error('정류장 정보를 불러오지 못했습니다.');
    }

    const stopMap = new Map();
    for (const resItem of fulfilled) {
      for (const s of resItem.value) {
        const sLat = parseFloat(s.gpslati);
        const sLng = parseFloat(s.gpslong);
        if (!s.nodeid || Number.isNaN(sLat) || Number.isNaN(sLng)) continue;

        const distance = getDistanceMeters(lat, lng, sLat, sLng);
        if (distance <= radius && !stopMap.has(s.nodeid)) {
          stopMap.set(s.nodeid, {
            nodeId: String(s.nodeid),
            nodeNo: s.nodeno ? String(s.nodeno) : '',
            cityCode: String(s.citycode),
            name: String(s.nodenm || '정류장'),
            lat: sLat,
            lng: sLng,
            distance
          });
        }
      }
    }

    const allStops = Array.from(stopMap.values()).sort((a, b) => a.distance - b.distance);

    // 1차 후보 추출: 넓은 반경에서도 바깥쪽 정류장이 빠지지 않도록 공간 분산
    const preSpacing = radius >= 1000 ? 140 : radius >= 500 ? 60 : 0;
    const maxCandidates = radius >= 1000 ? 18 : radius >= 500 ? 14 : 10;
    const candidates = [];

    for (const stop of allStops) {
      if (candidates.length >= maxCandidates) break;
      if (preSpacing > 0) {
        const tooClose = candidates.some(
          (picked) => getDistanceMeters(picked.lat, picked.lng, stop.lat, stop.lng) < preSpacing
        );
        if (tooClose) continue;
      }
      candidates.push(stop);
    }

    // 후보 정류장 실시간 도착 정보 병렬 조회
    const enrichedCandidates = await Promise.all(
      candidates.map(async (stop) => {
        try {
          const url =
            `https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList` +
            `?serviceKey=${serviceKey}&cityCode=${encodeURIComponent(stop.cityCode)}` +
            `&nodeId=${encodeURIComponent(stop.nodeId)}&numOfRows=30&pageNo=1&_type=json`;

          const arrivalsRaw = await fetchTago(url);
          const arrivals = arrivalsRaw
            .map((a) => ({
              routeId: String(a.routeid || ''),
              routeNo: String(a.routeno || ''),
              arrTime: parseInt(a.arrtime, 10) || 0,
              prevStations: parseInt(a.arrprevstationcnt, 10) || 0,
              routeType: String(a.routetp || ''),
              vehicleType: String(a.vehicletp || ''),
              bearing: null,
              nextStop: ''
            }))
            .filter((a) => a.routeNo && a.arrTime > 0)
            .sort((a, b) => a.arrTime - b.arrTime);

          return { ...stop, arrivals };
        } catch {
          return { ...stop, arrivals: [] };
        }
      })
    );

    // 2차 최종 선별: 1km/500m에서는 버스 많은 큰 정류장을 우선하되 배지 겹침 방지 간격 적용
    const finalSpacing = radius >= 1000 ? 260 : radius >= 500 ? 120 : 0;
    const maxVisible = radius >= 1000 ? 9 : radius >= 500 ? 7 : 6;

    const ranked = [...enrichedCandidates].sort((a, b) => {
      if (radius >= 500 && b.arrivals.length !== a.arrivals.length) {
        return b.arrivals.length - a.arrivals.length;
      }
      if (radius < 500) {
        const aHas = a.arrivals.length > 0 ? 1 : 0;
        const bHas = b.arrivals.length > 0 ? 1 : 0;
        if (bHas !== aHas) return bHas - aHas;
      }
      return a.distance - b.distance;
    });

    const visibleStops = [];
    for (const stop of ranked) {
      if (visibleStops.length >= maxVisible) break;
      if (finalSpacing > 0) {
        const tooClose = visibleStops.some(
          (picked) => getDistanceMeters(picked.lat, picked.lng, stop.lat, stop.lng) < finalSpacing
        );
        if (tooClose) continue;
      }
      visibleStops.push(stop);
    }

    // 최종 노출 정류장의 도착 버스 노선만 추려 방향(각도 + 다음 정류장) 계산
    const uniqueRoutes = new Map();
    // 각 정류장 1순위 버스 먼저 등록
    for (const stop of visibleStops) {
      const first = stop.arrivals[0];
      if (first && first.routeId && uniqueRoutes.size < 16) {
        uniqueRoutes.set(`${stop.cityCode}:${first.routeId}`, {
          cityCode: stop.cityCode,
          routeId: first.routeId
        });
      }
    }
    // 여유분으로 나머지 버스도 등록
    for (const stop of visibleStops) {
      for (const bus of stop.arrivals.slice(1, 5)) {
        if (bus.routeId && uniqueRoutes.size < 16) {
          uniqueRoutes.set(`${stop.cityCode}:${bus.routeId}`, {
            cityCode: stop.cityCode,
            routeId: bus.routeId
          });
        }
      }
    }

    const routeDataMap = new Map();
    await Promise.all(
      Array.from(uniqueRoutes.entries()).map(async ([key, info]) => {
        const stops = await getRouteStops(info.cityCode, info.routeId);
        if (stops) routeDataMap.set(key, stops);
      })
    );

    for (const stop of visibleStops) {
      for (const bus of stop.arrivals) {
        if (!bus.routeId) continue;
        const routeStops = routeDataMap.get(`${stop.cityCode}:${bus.routeId}`);
        if (routeStops) {
          const dir = calcDirection(routeStops, stop.nodeId);
          bus.bearing = dir.bearing;
          bus.nextStop = dir.nextStop;
        }
      }
    }

    return res.status(200).json({
      fetchedAt: Date.now(),
      totalFound: allStops.length,
      stops: visibleStops
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || '서버 오류가 발생했습니다.' });
  }
};