// api/bus.js
const zlib = require('zlib');

const routeStopCache = new Map();
const iconCache = new Map();
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 캐시

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createBusIconPng(size) {
  const s = size === 512 ? 512 : 192;
  if (iconCache.has(s)) return iconCache.get(s);

  const raw = Buffer.alloc(s * (s * 3 + 1));
  for (let y = 0; y < s; y++) {
    const rowStart = y * (s * 3 + 1);
    raw[rowStart] = 0;
    const ny = y / s;

    for (let x = 0; x < s; x++) {
      const nx = x / s;
      let r = 17, g = 24, b = 39; // #111827 배경

      const dx = nx - 0.5;
      const dy = ny - 0.5;
      if (dx * dx + dy * dy <= 0.41 * 0.41) {
        r = 37; g = 99; b = 235; // #2563eb 원형 배지
      }

      if (nx >= 0.28 && nx <= 0.72 && ny >= 0.25 && ny <= 0.71) {
        r = 255; g = 255; b = 255; // 버스 본체
        if (nx >= 0.33 && nx <= 0.67 && ny >= 0.32 && ny <= 0.52) {
          r = 17; g = 24; b = 39; // 앞유리
        }
        const leftLight = nx >= 0.34 && nx <= 0.42 && ny >= 0.59 && ny <= 0.65;
        const rightLight = nx >= 0.58 && nx <= 0.66 && ny >= 0.59 && ny <= 0.65;
        if (leftLight || rightLight) {
          r = 250; g = 204; b = 21; // 노란 헤드라이트
        }
      }

      const leftWheel = nx >= 0.33 && nx <= 0.43 && ny >= 0.71 && ny <= 0.78;
      const rightWheel = nx >= 0.57 && nx <= 0.67 && ny >= 0.71 && ny <= 0.78;
      if (leftWheel || rightWheel) {
        r = 255; g = 255; b = 255;
      }

      const idx = rowStart + 1 + x * 3;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(raw);

  const png = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  iconCache.set(s, png);
  return png;
}

async function fetchWithTimeout(url, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTago(url) {
  const response = await fetchWithTimeout(url);
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

async function getStopArrivals(serviceKey, cityCode, nodeId) {
  const url =
    `https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList` +
    `?serviceKey=${serviceKey}&cityCode=${encodeURIComponent(cityCode)}` +
    `&nodeId=${encodeURIComponent(nodeId)}&numOfRows=30&pageNo=1&_type=json`;

  const arrivalsRaw = await fetchTago(url);
  return arrivalsRaw
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
}

async function getRouteStops(serviceKey, cityCode, routeId) {
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
  const target = routeStops[idx + 1];
  const nextStop = target ? target.name : '종점';
  let from = curr;
  let to = target;

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

  const bearing = Math.round(((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360);
  return { bearing, nextStop };
}

function findOppositeStop(stop, allStops) {
  const cleanName = (n) => String(n || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '');
  const myClean = cleanName(stop.name);

  const nearby = allStops
    .filter((other) => other.nodeId !== stop.nodeId)
    .map((other) => ({
      ...other,
      gap: getDistanceMeters(stop.lat, stop.lng, other.lat, other.lng)
    }))
    .filter((other) => other.gap >= 10 && other.gap <= 140);

  if (nearby.length === 0) return null;

  nearby.sort((a, b) => {
    const aSame = cleanName(a.name) === myClean ? 1 : 0;
    const bSame = cleanName(b.name) === myClean ? 1 : 0;
    if (bSame !== aSame) return bSame - aSame;
    return a.gap - b.gap;
  });

  const opp = nearby[0];
  return {
    nodeId: opp.nodeId,
    nodeNo: opp.nodeNo,
    cityCode: opp.cityCode,
    name: opp.name,
    lat: opp.lat,
    lng: opp.lng,
    distance: opp.distance
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = String(req.query.action || '');

  // 1) 앱 설치용 PNG 아이콘 반환
  if (action === 'icon') {
    const size = parseInt(req.query.size, 10) === 512 ? 512 : 192;
    const png = createBusIconPng(size);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).end(png);
  }

  const rawKey = (process.env.TAGO_API_KEY || '').trim();
  if (!rawKey) {
    return res.status(500).json({
      error: 'Vercel 환경변수(TAGO_API_KEY)가 설정되지 않았습니다.'
    });
  }
  const serviceKey = rawKey.includes('%') ? rawKey : encodeURIComponent(rawKey);

  // 2) 방향 화살표·방면 안내만 백그라운드 별도 조회 (초기 로딩 차단 없음)
  if (action === 'directions') {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    const rawItems = String(req.query.items || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 16);

    const parsed = rawItems
      .map((item) => {
        const [cityCode, routeId, nodeId] = item.split('|');
        return cityCode && routeId && nodeId ? { key: item, cityCode, routeId, nodeId } : null;
      })
      .filter(Boolean);

    const uniqueRoutes = new Map();
    for (const p of parsed) {
      const rKey = `${p.cityCode}:${p.routeId}`;
      if (!uniqueRoutes.has(rKey)) uniqueRoutes.set(rKey, p);
    }

    const routeMap = new Map();
    await Promise.all(
      Array.from(uniqueRoutes.entries()).map(async ([rKey, info]) => {
        const stops = await getRouteStops(serviceKey, info.cityCode, info.routeId);
        if (stops) routeMap.set(rKey, stops);
      })
    );

    const directions = {};
    for (const p of parsed) {
      const stops = routeMap.get(`${p.cityCode}:${p.routeId}`);
      if (stops) {
        directions[p.key] = calcDirection(stops, p.nodeId);
      }
    }

    return res.status(200).json({ directions });
  }

  // 3) 반대편 정류장 단일 조회
  if (action === 'stop') {
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    const cityCode = String(req.query.cityCode || '').trim();
    const nodeId = String(req.query.nodeId || '').trim();
    if (!cityCode || !nodeId) {
      return res.status(400).json({ error: '정류장 정보가 올바르지 않습니다.' });
    }
    try {
      const arrivals = await getStopArrivals(serviceKey, cityCode, nodeId);
      return res.status(200).json({ fetchedAt: Date.now(), arrivals });
    } catch (err) {
      return res.status(500).json({ error: err.message || '정류장 정보를 불러오지 못했습니다.' });
    }
  }

  // 4) 기본: 주변 정류장 + 도착 시간 초고속 조회
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = Math.min(Math.max(parseInt(req.query.radius, 10) || 250, 100), 1500);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: '위치 좌표(lat, lng)가 올바르지 않습니다.' });
  }

  try {
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

    const preSpacing = radius >= 1000 ? 150 : radius >= 500 ? 65 : 0;
    const maxCandidates = radius >= 1000 ? 15 : radius >= 500 ? 12 : 8;
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

    const enrichedCandidates = await Promise.all(
      candidates.map(async (stop) => {
        try {
          const arrivals = await getStopArrivals(serviceKey, stop.cityCode, stop.nodeId);
          return { ...stop, arrivals };
        } catch {
          return { ...stop, arrivals: [] };
        }
      })
    );

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
      visibleStops.push({
        ...stop,
        oppositeStop: findOppositeStop(stop, allStops)
      });
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