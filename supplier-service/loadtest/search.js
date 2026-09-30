// Load test for N2.1.1 and N2.2.1: search and filter reads from 1000
// concurrent clients must stay within 100 ms.
//
// Each virtual client is a member who searches, looks at the answer for about a
// second, and searches again. The clients join over 15 seconds, as real users
// would, and only the requests made once all of them are in are judged.
//
// Run it from the repository root, with the stack up (docker compose up -d):
//   docker run --rm -i --network foc-template_default \
//     -v "$PWD/supplier-service/loadtest:/scripts:ro" -e BASE=http://supplier-service:3002 \
//     grafana/k6 run --summary-trend-stats "avg,med,p(95),p(99),p(99.9),max" /scripts/search.js
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE || 'http://localhost:3002'
const CLIENTS = Number(__ENV.CLIENTS || 1000)
const RAMP_SECONDS = 15
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 30)
// Share of searches that are a keyword nobody asked for a moment ago, so that
// they cannot be served from the service's short-lived memory.
const UNIQUE_SHARE = Number(__ENV.UNIQUE_SHARE || 0.2)

const COMMON = [
  '',
  'q=coffee',
  'q=printer',
  'q=prince+george',
  'q=cafe&type=Food/Coffee',
  'type=Printing',
  'type=Food&zone=Central',
  'type=Shopping',
  'zone=Computing',
  'building=COM2',
  'page=2',
]
const UNIQUE = Array.from({ length: 300 }, (_, i) => 'q=' + (i * 7919).toString(36).slice(0, 3))

export const options = {
  scenarios: {
    clients: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMP_SECONDS}s`, target: CLIENTS },
        { duration: `${HOLD_SECONDS}s`, target: CLIENTS },
      ],
    },
  },
  thresholds: {
    'http_req_duration{phase:steady}': ['p(99)<100'],
    'http_req_failed{phase:steady}': ['rate<0.001'],
  },
}

export function setup() {
  return { start: Date.now() }
}

export default function (data) {
  const pool = Math.random() < UNIQUE_SHARE ? UNIQUE : COMMON
  const query = pool[Math.floor(Math.random() * pool.length)]
  const phase = Date.now() - data.start > RAMP_SECONDS * 1000 ? 'steady' : 'ramp'

  const response = http.get(`${BASE}/suppliers${query ? '?' + query : ''}`, {
    headers: { Authorization: 'Bearer member-token' },
    tags: { phase },
  })
  check(response, { 'status is 200': (r) => r.status === 200 })
  sleep(0.5 + Math.random())
}
