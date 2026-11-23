// api/bus.js
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const rawKey = (process.env.TAGO_API_KEY || '').trim();
  if (!rawKey) {
    return res.status(500).json({
      error: 'Vercel 환경변수(TAGO_API_KEY)가 설정되지 않았습니다.'
    });
  }

  // Encoding / Decoding 키 어느 쪽을 넣어도 정상 작동하도록 자동 처리
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

    // 공공데이터포털은 키 미반영/오류 시 JSON 요청에도 XML을 반환함
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

  try {
    // TAGO 근접 정류소 API는 기본 500m 반경이므로, 1km 선택 시 동서남북 지점을 함께 조회
    const queryPoints = [{ lat, lng }];
    if (radius > 500) {
      queryPoints.push(
        { lat: lat + 0.0045, lng },
        { lat: lat - 0.0045, lng },
        { lat, lng: lng + 0.0056 },
        { lat, lng: lng - 0.0056 }
      );
    }

    const stopResults = await Promise.allSettled(
      queryPoints.map((pt) => {
        const url =
          `https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList` +
          `?serviceKey=${serviceKey}&gpsLati=${pt.lat}&gpsLong=${pt.lng}&numOfRows=30&pageNo=1&_type=json`;
        return fetchTago(url);
      })
    );

    // 모든 요청이 실패한 경우 첫 번째 에러 반환
    const fulfilled = stopResults.filter((r) => r.status === 'fulfilled');
    if (fulfilled.length === 0) {
      const firstErr = stopResults.find((r) => r.status === 'rejected');
      throw firstErr?.reason || new Error('정류장 정보를 불러오지 못했습니다.');
    }

    // 중복 정류장 제거 및 반경 필터링
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

    // 반경에 정류장이 너무 많을 때 겹침 방지 및 API 호출 최적화 (최대 12곳 조회)
    const minSpacing = radius >= 1000 ? 110 : radius >= 500 ? 35 : 0;
    const selectedStops = [];
    for (const stop of allStops) {
      if (selectedStops.length >= 12) break;
      if (minSpacing > 0) {
        const tooClose = selectedStops.some(
          (picked) => getDistanceMeters(picked.lat, picked.lng, stop.lat, stop.lng) < minSpacing
        );
        if (tooClose) continue;
      }
      selectedStops.push(stop);
    }

    // 선택된 정류장들의 실시간 도착 정보 병렬 조회
    const enrichedStops = await Promise.all(
      selectedStops.map(async (stop) => {
        try {
          const url =
            `https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList` +
            `?serviceKey=${serviceKey}&cityCode=${encodeURIComponent(stop.cityCode)}` +
            `&nodeId=${encodeURIComponent(stop.nodeId)}&numOfRows=30&pageNo=1&_type=json`;

          const arrivalsRaw = await fetchTago(url);
          const arrivals = arrivalsRaw
            .map((a) => ({
              routeNo: String(a.routeno || ''),
              arrTime: parseInt(a.arrtime, 10) || 0, // 초 단위
              prevStations: parseInt(a.arrprevstationcnt, 10) || 0,
              routeType: String(a.routetp || ''),
              vehicleType: String(a.vehicletp || '')
            }))
            .filter((a) => a.routeNo && a.arrTime > 0)
            .sort((a, b) => a.arrTime - b.arrTime);

          return { ...stop, arrivals };
        } catch {
          return { ...stop, arrivals: [] };
        }
      })
    );

    return res.status(200).json({
      fetchedAt: Date.now(),
      totalFound: allStops.length,
      stops: enrichedStops
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || '서버 오류가 발생했습니다.' });
  }
};