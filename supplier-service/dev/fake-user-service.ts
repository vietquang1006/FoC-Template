// A stand-in for the User Service, so that the Supplier Service can be run and
// tested before the real one exists. It answers two requests:
//   POST /login      username and password in, a session out (placeholder users)
//   POST /authorize  the question described in src/auth.ts
// None of the passwords or tokens here are secrets. It is never part of the
// service's container image, and it must never be reachable from outside.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

interface Session {
  accountId: string
  active: boolean
  roles: string[]
}

interface User extends Session {
  password: string
}

// Sessions that already exist, as if issued earlier. The suspended one is a
// session that was valid until its account was suspended.
export const SESSIONS: Record<string, Session> = {
  'member-token': { accountId: 'member-account-1', active: true, roles: ['member'] },
  'admin-token': {
    accountId: 'admin-account-1',
    active: true,
    roles: ['member', 'administrator'],
  },
  'suspended-token': { accountId: 'member-account-2', active: false, roles: ['member'] },
}

// The placeholder people who can log in. The real User Service will have real
// accounts. The account ids match the sessions above.
export const USERS: Record<string, User> = {
  student: {
    password: 'student-pass',
    accountId: 'member-account-1',
    active: true,
    roles: ['member'],
  },
  admin: {
    password: 'admin-pass',
    accountId: 'admin-account-1',
    active: true,
    roles: ['member', 'administrator'],
  },
  suspended: {
    password: 'suspended-pass',
    accountId: 'member-account-2',
    active: false,
    roles: ['member'],
  },
}

// Mirrors F1.5.4: administrators create, update and deactivate suppliers, and
// any member may read them.
const REQUIRED_ROLE: Record<string, string> = {
  'supplier.read': 'member',
  'supplier.create': 'administrator',
  'supplier.update': 'administrator',
  'supplier.deactivate': 'administrator',
}

export function createFakeUserService(log: (line: string) => void = () => {}): Server {
  // The fixed sessions, and every session a login has issued since start-up.
  const sessions = new Map<string, Session & { label: string }>()
  for (const [token, session] of Object.entries(SESSIONS)) {
    sessions.set(token, { ...session, label: token })
  }

  return createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const send = (status: number, payload?: object) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(payload ? JSON.stringify(payload) : undefined)
      }

      let body: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
      } catch {
        return send(400)
      }

      if (request.method === 'POST' && request.url === '/login') {
        const username = typeof body.username === 'string' ? body.username : ''
        const user = Object.hasOwn(USERS, username) ? USERS[username] : undefined
        const answer = (status: number, payload: object) => {
          log(`login ${username || '(none)'} -> ${status}`)
          send(status, payload)
        }

        // An unknown user and a wrong password get the identical answer (F1.3.2).
        if (!user || user.password !== body.password) {
          return answer(401, { error: 'Invalid username or password' })
        }
        // An account that is not Active gets no session (F1.3.4).
        if (!user.active) return answer(403, { error: 'This account is not active' })

        const token = `session-${randomBytes(9).toString('hex')}`
        sessions.set(token, {
          accountId: user.accountId,
          active: true,
          roles: user.roles,
          label: `${username} (${token.slice(-6)})`,
        })
        return answer(200, { token, accountId: user.accountId, roles: user.roles })
      }

      if (request.method === 'POST' && request.url === '/authorize') {
        const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
        const session = token ? sessions.get(token) : undefined
        const operation = body.operation
        const reply = (status: number, payload?: object) => {
          const who = session ? session.label : token ? '(unknown session)' : '(no session)'
          log(`authorize ${String(operation ?? '-')} for ${who} -> ${status}`)
          send(status, payload)
        }

        if (!session) return reply(401)
        const role = typeof operation === 'string' ? REQUIRED_ROLE[operation] : undefined
        if (!role) return reply(400)
        if (!session.active || !session.roles.includes(role)) return reply(403)
        return reply(200, { accountId: session.accountId })
      }

      send(404)
    })
  })
}

if (import.meta.main) {
  const port = Number(new URL(process.env.USER_SERVICE_URL || 'http://localhost:3001').port || 3001)
  createFakeUserService((line) => console.log(line)).listen(port, () => {
    console.log(`Fake user service on port ${port}.`)
    console.log(`Log in at POST /login as: ${Object.keys(USERS).join(', ')}`)
    console.log(`Or use a fixed session: ${Object.keys(SESSIONS).join(', ')}`)
  })
}
