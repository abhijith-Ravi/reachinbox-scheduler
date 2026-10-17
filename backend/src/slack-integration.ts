import type { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { encryptSecret } from './slack-security'
import { SlackOAuthStateStore } from './slack-security'

export const SLACK_DEPLOYMENT_KEY = 'default'
const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access'
const REQUESTED_SCOPES = 'incoming-webhook'

export interface SlackConfig {
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_REDIRECT_URL?: string
  SLACK_TOKEN_ENCRYPTION_KEY?: string
}

export class SlackOAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

type FetchLike = typeof fetch

export class SlackIntegration {
  private readonly states: SlackOAuthStateStore

  constructor(
    private readonly prisma: PrismaClient,
    redis: Redis,
    private readonly config: SlackConfig,
    private readonly fetcher: FetchLike = fetch,
    private readonly deploymentKey = SLACK_DEPLOYMENT_KEY,
  ) {
    this.states = new SlackOAuthStateStore(redis)
  }

  async startOAuth(): Promise<string> {
    const oauth = this.requireOAuthConfig()
    const state = await this.states.create()
    const authorize = new URL(SLACK_AUTHORIZE_URL)
    authorize.searchParams.set('client_id', oauth.clientId)
    authorize.searchParams.set('scope', REQUESTED_SCOPES)
    authorize.searchParams.set('redirect_uri', oauth.redirectUrl)
    authorize.searchParams.set('state', state)
    return authorize.toString()
  }

  async handleCallback(params: URLSearchParams): Promise<{ workspaceId: string; workspaceName: string; channelId: string; channelName: string }> {
    const state = params.get('state')
    if (!state || !await this.states.consume(state)) {
      throw new SlackOAuthError(400, 'OAUTH_STATE_INVALID', 'Slack authorization state is missing, expired, or already used.')
    }

    const denied = params.get('error')
    if (denied) throw new SlackOAuthError(400, 'OAUTH_DENIED', 'Slack authorization was denied.')
    const code = params.get('code')
    if (!code || code.length > 4096) throw new SlackOAuthError(400, 'OAUTH_CODE_MISSING', 'Slack did not return a valid authorization code.')

    const oauth = this.requireOAuthConfig()
    let slackResponse: SlackOAuthResponse
    try {
      const body = new URLSearchParams({
        code,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        redirect_uri: oauth.redirectUrl,
      })
      const response = await this.fetcher(SLACK_ACCESS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      slackResponse = await response.json() as SlackOAuthResponse
      if (!response.ok || slackResponse.ok !== true) {
        throw new Error('Slack rejected the OAuth token exchange.')
      }
    } catch {
      throw new SlackOAuthError(502, 'SLACK_TOKEN_EXCHANGE_FAILED', 'Slack authorization could not be completed. Please try again.')
    }

    const teamId = slackResponse.team?.id
    const teamName = slackResponse.team?.name
    const webhook = slackResponse.incoming_webhook
    if (!teamId || !teamName || !webhook?.channel_id || !webhook.channel || !isSlackWebhookUrl(webhook.url)) {
      throw new SlackOAuthError(502, 'SLACK_INSTALLATION_INVALID', 'Slack did not return a usable workspace webhook installation.')
    }
    const encryptionKey = this.config.SLACK_TOKEN_ENCRYPTION_KEY
    if (!encryptionKey) throw new SlackOAuthError(503, 'SLACK_NOT_CONFIGURED', 'Slack encryption is not configured on this server.')
    const encrypted = encryptSecret(webhook.url, encryptionKey)

    await this.prisma.slackConnection.upsert({
      where: { deploymentKey: this.deploymentKey },
      create: {
        deploymentKey: this.deploymentKey,
        workspaceId: teamId,
        workspaceName: teamName,
        channelId: webhook.channel_id,
        channelName: webhook.channel,
        webhookCiphertext: encrypted.ciphertext,
        webhookNonce: encrypted.nonce,
        webhookAuthTag: encrypted.authTag,
        status: 'ACTIVE',
      },
      update: {
        workspaceId: teamId,
        workspaceName: teamName,
        channelId: webhook.channel_id,
        channelName: webhook.channel,
        webhookCiphertext: encrypted.ciphertext,
        webhookNonce: encrypted.nonce,
        webhookAuthTag: encrypted.authTag,
        status: 'ACTIVE',
        installedAt: new Date(),
      },
    })

    // Slack's OAuth response includes access_token; this integration uses the
    // channel-scoped incoming webhook and intentionally does not retain it.
    return { workspaceId: teamId, workspaceName: teamName, channelId: webhook.channel_id, channelName: webhook.channel }
  }

  async getConnection() {
    const connection = await this.prisma.slackConnection.findUnique({ where: { deploymentKey: this.deploymentKey } })
    if (!connection) return { connected: false as const }
    return {
      connected: connection.status === 'ACTIVE',
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      channelId: connection.channelId,
      channelName: connection.channelName,
      status: connection.status,
      installedAt: connection.installedAt.toISOString(),
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.slackConnection.deleteMany({ where: { deploymentKey: this.deploymentKey } })
  }

  private requireOAuthConfig(): { clientId: string; clientSecret: string; redirectUrl: string } {
    const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret, SLACK_REDIRECT_URL: redirectUrl, SLACK_TOKEN_ENCRYPTION_KEY: key } = this.config
    if (!clientId || !clientSecret || !redirectUrl || !key) {
      throw new SlackOAuthError(503, 'SLACK_NOT_CONFIGURED', 'Slack OAuth and encryption configuration is incomplete.')
    }
    return { clientId, clientSecret, redirectUrl }
  }
}

interface SlackOAuthResponse {
  ok?: boolean
  team?: { id?: string; name?: string }
  incoming_webhook?: { url?: string; channel_id?: string; channel?: string }
  access_token?: string
}

function isSlackWebhookUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com'
  } catch {
    return false
  }
}
