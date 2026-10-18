import { createHmac, timingSafeEqual } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'

export const GOOGLE_SESSION_COOKIE = 'reachinbox_session'
export const GOOGLE_SESSION_SECONDS = 8 * 60 * 60

export interface GoogleUser {
  id: string
  email: string
  name: string
  picture: string | null
}

export interface GoogleTokenClaims {
  sub?: string
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
}

type GoogleTokenVerifier = (credential: string, audience: string) => Promise<GoogleTokenClaims | undefined>

export class GoogleAuthenticationError extends Error {}

export class GoogleAuthService {
  private readonly verifier: GoogleTokenVerifier

  constructor(
    private readonly clientId: string,
    private readonly sessionSecret: string,
    verifier?: GoogleTokenVerifier,
  ) {
    const client = new OAuth2Client(clientId)
    this.verifier = verifier ?? (async (credential, audience) => {
      const ticket = await client.verifyIdToken({ idToken: credential, audience })
      return ticket.getPayload()
    })
  }

  async authenticate(credential: string): Promise<{ user: GoogleUser; cookieValue: string }> {
    try {
      const claims = await this.verifier(credential, this.clientId)
      if (!claims?.sub || !claims.email || claims.email_verified !== true && claims.email_verified !== 'true') {
        throw new GoogleAuthenticationError('Google account email is not verified.')
      }
      const user: GoogleUser = {
        id: claims.sub,
        email: claims.email,
        name: claims.name?.trim() || claims.email,
        picture: claims.picture ?? null,
      }
      const payload = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + GOOGLE_SESSION_SECONDS })).toString('base64url')
      return { user, cookieValue: `${payload}.${this.sign(payload)}` }
    } catch {
      throw new GoogleAuthenticationError('Google sign-in could not be verified. Please try again.')
    }
  }

  readSession(cookieValue: string | undefined): GoogleUser | null {
    if (!cookieValue || cookieValue.length > 8192) return null
    const separator = cookieValue.lastIndexOf('.')
    if (separator < 1) return null
    const payload = cookieValue.slice(0, separator)
    const signature = cookieValue.slice(separator + 1)
    const expected = this.sign(payload)
    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleUser & { exp?: number }
      if (!session.id || !session.email || typeof session.name !== 'string' || !Number.isInteger(session.exp) || session.exp! <= Math.floor(Date.now() / 1000)) return null
      return { id: session.id, email: session.email, name: session.name, picture: typeof session.picture === 'string' ? session.picture : null }
    } catch {
      return null
    }
  }

  cookie(value: string, secure: boolean): string {
    return `${GOOGLE_SESSION_COOKIE}=${value}; HttpOnly; Path=/api; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=${GOOGLE_SESSION_SECONDS}${secure ? '; Secure' : ''}`
  }

  clearCookie(secure: boolean): string {
    return `${GOOGLE_SESSION_COOKIE}=; HttpOnly; Path=/api; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=0${secure ? '; Secure' : ''}`
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.sessionSecret).update(payload).digest('base64url')
  }
}

export function googleSessionFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  const value = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${GOOGLE_SESSION_COOKIE}=`))
  return value?.slice(GOOGLE_SESSION_COOKIE.length + 1)
}
