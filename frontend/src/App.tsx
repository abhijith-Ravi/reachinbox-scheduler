import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type GoogleUser = { id: string; email: string; name: string; picture: string | null }

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(options: { client_id: string; callback(response: { credential: string }): void }): void
      renderButton(element: HTMLElement, options: Record<string, string | number>): void
      prompt(callback?: (notification: { isDismissedMoment(): boolean; isSkippedMoment(): boolean }) => void): void
      disableAutoSelect(): void
    } } }
  }
}

type EmailRecord = {
  id: string
  sender: { id: string; email: string; name: string | null }
  recipient: string
  subject: string
  body: string
  scheduledAt: string
  status: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED'
  attemptCount: number
  lastError: string | null
  smtpAcceptedAt: string | null
  createdAt: string
}

type EmailList = {
  data: EmailRecord[]
  pagination: { limit: number; nextCursor: string | null }
}

type EmailTab = 'scheduled' | 'sent'
type ParsedRecipients = { valid: string[]; invalid: string[]; duplicates: number }

const API_BASE_URL = import.meta.env.DEV ? (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '') : ''
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || ''
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const payload = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed with status ${response.status}.`)
  if (payload === null) throw new Error('The API returned an empty or invalid JSON response.')
  return payload as T
}

function parseRecipients(text: string): ParsedRecipients {
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  let duplicates = 0

  for (const part of text.split(/[\n,;]+/)) {
    const cleaned = part.trim().replace(/^['"<\s]+|['">\s]+$/g, '')
    if (!cleaned) continue
    const matches = cleaned.match(EMAIL_PATTERN) ?? []
    if (!matches.length) {
      invalid.push(cleaned)
      continue
    }
    for (const address of matches) {
      if (!isValidEmail(address)) {
        invalid.push(address)
        continue
      }
      const key = address.toLowerCase()
      if (seen.has(key)) {
        duplicates += 1
        continue
      }
      seen.add(key)
      valid.push(address)
    }
  }

  return { valid, invalid: [...new Set(invalid)], duplicates }
}

function parseCsv(content: string): string[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      row.push(cell.trim())
      cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      row.push(cell.trim())
      if (row.some((value) => value)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  row.push(cell.trim())
  if (row.some((value) => value)) rows.push(row)

  const entries: string[] = []
  for (const values of rows) {
    for (const value of values) {
      if (/^(e-?mail|recipient|email address)$/i.test(value.trim())) continue
      const matches = value.match(EMAIL_PATTERN)
      if (matches?.length) entries.push(...matches)
      else if (value.includes('@')) entries.push(value)
    }
  }
  return entries
}

function isValidEmail(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)
}

function makeLocalDateTime(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function makeIdempotencySeed(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

export default function App() {
  const [authState, setAuthState] = useState<'checking' | 'disabled' | 'required' | 'configuration-error' | 'unavailable'>('checking')
  const [authUser, setAuthUser] = useState<GoogleUser | null>(null)
  const [authError, setAuthError] = useState('')
  const [authPending, setAuthPending] = useState(false)
  const googleButtonRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<EmailTab>('scheduled')
  const [scheduled, setScheduled] = useState<EmailRecord[]>([])
  const [sent, setSent] = useState<EmailRecord[]>([])
  const [scheduledCursor, setScheduledCursor] = useState<string | null>(null)
  const [sentCursor, setSentCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiStatus, setApiStatus] = useState<'connecting' | 'connected' | 'unavailable'>('connecting')
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshError, setRefreshError] = useState<{ scheduled?: string; sent?: string }>({})
  const [composeOpen, setComposeOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitNotice, setSubmitNotice] = useState('')
  const [scheduledIndexes, setScheduledIndexes] = useState<Set<number>>(new Set())
  const [campaignAttempted, setCampaignAttempted] = useState(false)
  const [campaignId, setCampaignId] = useState(makeIdempotencySeed)
  const [recipientInput, setRecipientInput] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [startAt, setStartAt] = useState(() => makeLocalDateTime(new Date(Date.now() + 5 * 60_000)))
  const [delaySeconds, setDelaySeconds] = useState('30')
  const [hourlyLimit, setHourlyLimit] = useState('100')
  const [fileError, setFileError] = useState('')

  const recipients = useMemo(() => parseRecipients(recipientInput), [recipientInput])
  const visibleRows = activeTab === 'scheduled' ? scheduled : sent
  const currentError = activeTab === 'scheduled' ? refreshError.scheduled : refreshError.sent
  const nextCursor = activeTab === 'scheduled' ? scheduledCursor : sentCursor

  useEffect(() => {
    let mounted = true
    void apiRequest<{ data: { enabled: boolean; configurationError: boolean; user: GoogleUser | null } }>('/api/auth/session')
      .then(({ data }) => {
        if (!mounted) return
        setAuthUser(data.user)
        setAuthState(data.configurationError ? 'configuration-error' : data.enabled ? 'required' : 'disabled')
      })
      .catch(() => { if (mounted) setAuthState('unavailable') })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (authState !== 'required' || authUser || !googleButtonRef.current) return
    if (!GOOGLE_CLIENT_ID) {
      setAuthError('Set VITE_GOOGLE_CLIENT_ID to the Web OAuth client ID, then restart Vite.')
      return
    }
    let attempts = 0
    let initialized = false
    const timer = window.setInterval(() => {
      attempts += 1
      const google = window.google
      const element = googleButtonRef.current
      if (!google || !element) {
        if (attempts >= 50) {
          window.clearInterval(timer)
          setAuthError('Google sign-in could not load. Check your connection and reload this page.')
        }
        return
      }
      window.clearInterval(timer)
      if (initialized) return
      initialized = true
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async ({ credential }) => {
          setAuthError('')
          setAuthPending(true)
          try {
            const result = await apiRequest<{ data: { user: GoogleUser } }>('/api/auth/google', {
              method: 'POST',
              body: JSON.stringify({ credential }),
            })
            setAuthUser(result.data.user)
            setAuthError('')
          } catch (error) {
            setAuthError(errorMessage(error))
          } finally {
            setAuthPending(false)
          }
        },
      })
      google.accounts.id.renderButton(element, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 320 })
      google.accounts.id.prompt((notification) => {
        if (notification.isDismissedMoment() || notification.isSkippedMoment()) setAuthError('Sign-in was cancelled. Select the Google button to try again.')
      })
    }, 200)
    return () => window.clearInterval(timer)
  }, [authState, authUser])

  async function logout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
      window.google?.accounts.id.disableAutoSelect()
      setAuthUser(null)
      setAuthState('required')
      setAuthError('You have been signed out.')
    } catch (error) {
      setAuthError(`Could not sign out: ${errorMessage(error)}`)
    }
  }

  const refreshDashboard = useCallback(async () => {
    setLoading(true)
    setRefreshError({})
    const [scheduledResult, sentResult] = await Promise.allSettled([
      apiRequest<EmailList>('/api/emails/scheduled?limit=25'),
      apiRequest<EmailList>('/api/emails/sent?limit=25'),
    ])
    setApiStatus(scheduledResult.status === 'fulfilled' || sentResult.status === 'fulfilled' ? 'connected' : 'unavailable')
    if (scheduledResult.status === 'fulfilled') {
      setScheduled(scheduledResult.value.data)
      setScheduledCursor(scheduledResult.value.pagination.nextCursor)
    } else {
      setRefreshError((current) => ({ ...current, scheduled: errorMessage(scheduledResult.reason) }))
    }
    if (sentResult.status === 'fulfilled') {
      setSent(sentResult.value.data)
      setSentCursor(sentResult.value.pagination.nextCursor)
    } else {
      setRefreshError((current) => ({ ...current, sent: errorMessage(sentResult.reason) }))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (authState === 'required' && !authUser) return
    void refreshDashboard()
  }, [authState, authUser, refreshDashboard])

  useEffect(() => {
    if (!composeOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCompose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [composeOpen, closeCompose])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const path = activeTab === 'scheduled' ? '/api/emails/scheduled' : '/api/emails/sent'
      const page = await apiRequest<EmailList>(`${path}?limit=25&cursor=${encodeURIComponent(nextCursor)}`)
      if (activeTab === 'scheduled') {
        setScheduled((current) => [...current, ...page.data])
        setScheduledCursor(page.pagination.nextCursor)
      } else {
        setSent((current) => [...current, ...page.data])
        setSentCursor(page.pagination.nextCursor)
      }
    } catch (error) {
      setRefreshError((current) => ({ ...current, [activeTab]: errorMessage(error) }))
    } finally {
      setLoadingMore(false)
    }
  }

  function openCompose() {
    setCampaignId(makeIdempotencySeed())
    setScheduledIndexes(new Set())
    setCampaignAttempted(false)
    setRecipientInput('')
    setSubject('')
    setBody('')
    setStartAt(makeLocalDateTime(new Date(Date.now() + 5 * 60_000)))
    setDelaySeconds('30')
    setHourlyLimit('100')
    setFileError('')
    setSubmitError('')
    setSubmitNotice('')
    setComposeOpen(true)
  }

  async function uploadCsv(file: File | undefined) {
    if (!file) return
    setFileError('')
    try {
      const entries = parseCsv(await file.text())
      if (!entries.length) {
        setFileError('No email addresses were found in that file. Try a CSV column containing email addresses.')
        return
      }
      setRecipientInput((current) => [current.trim(), ...entries].filter(Boolean).join('\n'))
    } catch {
      setFileError('The CSV could not be read. Please try a UTF-8 CSV file.')
    }
  }

  async function scheduleCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitError('')
    setSubmitNotice('')

    const startDate = new Date(startAt)
    const delay = Number(delaySeconds)
    const hourly = Number(hourlyLimit)
    if (!Number.isFinite(startDate.getTime()) || startDate.getTime() <= Date.now()) {
      setSubmitError('Choose a start time in the future.')
      return
    }
    if (!Number.isInteger(delay) || delay < 0 || delay > 86_400) {
      setSubmitError('Minimum delay must be between 0 and 86,400 seconds.')
      return
    }
    if (!Number.isInteger(hourly) || hourly < 1 || hourly > 100_000) {
      setSubmitError('Hourly sending limit must be a whole number between 1 and 100,000.')
      return
    }
    if (recipients.invalid.length) {
      setSubmitError('Fix or remove the invalid recipient entries before scheduling.')
      return
    }
    if (!recipients.valid.length) {
      setSubmitError('Add at least one valid recipient.')
      return
    }
    if (!subject.trim() || !body.trim()) {
      setSubmitError('Add both a subject and an email body.')
      return
    }

    setSubmitting(true)
    setCampaignAttempted(true)
    let completedCount = scheduledIndexes.size
    try {
      for (let index = 0; index < recipients.valid.length; index += 1) {
        if (scheduledIndexes.has(index)) continue
        const pacedOffset = index * delay * 1000
        const hourlyOffset = Math.floor(index / hourly) * 60 * 60 * 1000
        const scheduledAt = new Date(startDate.getTime() + Math.max(pacedOffset, hourlyOffset))
        try {
          await apiRequest('/api/emails/schedule', {
            method: 'POST',
            body: JSON.stringify({
              senderId: 'default',
              recipient: recipients.valid[index],
              subject: subject.trim(),
              body: body.trim(),
              scheduledAt: scheduledAt.toISOString(),
              idempotencyKey: `${campaignId}-${index}`,
            }),
          })
        } catch (error) {
          setSubmitError(`Scheduled ${completedCount} of ${recipients.valid.length}. ${errorMessage(error)} Retry to continue safely; accepted recipients use the same idempotency keys.`)
          return
        }
        setScheduledIndexes((current) => new Set(current).add(index))
        completedCount += 1
      }

      setSubmitNotice(`Scheduled ${completedCount} ${completedCount === 1 ? 'email' : 'emails'}.`)
      await refreshDashboard()
      setComposeOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  function closeCompose() {
    if (submitting) return
    if (campaignAttempted && scheduledIndexes.size < recipients.valid.length) {
      const confirmed = window.confirm('Some recipients may already be queued. Closing will discard this safe retry state. Close anyway?')
      if (!confirmed) return
    }
    setComposeOpen(false)
  }

  if (authState === 'checking') return <main className="auth-shell"><section className="auth-card" aria-live="polite">Checking sign-in status…</section></main>
  if (authState === 'configuration-error') return <main className="auth-shell"><section className="auth-card"><h1>Google sign-in setup is incomplete</h1><p>Configure both <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_SESSION_SECRET</code> in the backend environment, then restart the API.</p></section></main>
  if (authState === 'required' && !authUser) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark auth-brand-mark"><BrandIcon /></div><p className="eyebrow">REACHINBOX</p><h1>Sign in to your workspace</h1><p className="auth-copy">Use your Google account to continue to the email scheduler.</p><div ref={googleButtonRef} className="google-button" aria-busy={authPending} />{authPending && <p className="auth-pending" role="status">Verifying your Google account…</p>}{authError && <p className="auth-error" role="alert">{authError}</p>}</section></main>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#dashboard" aria-label="ReachInbox dashboard">
          <span className="brand-mark"><BrandIcon /></span>
          <span>reach<span className="brand-light">inbox</span></span>
        </a>
        <p className="nav-label">WORKSPACE</p>
        <button className="nav-item nav-item-active" type="button"><GridIcon /> Campaigns</button>
        <div className="sidebar-spacer" />
        <div className="sidebar-tip">
          <div className="tip-icon"><SparkleIcon /></div>
          <p className="tip-title">Keep your outreach on track</p>
          <p className="tip-copy">Schedule thoughtfully and let ReachInbox take care of the timing.</p>
        </div>
        <div className="profile-row">
          {authUser?.picture ? <img className="profile-avatar profile-image" src={authUser.picture} alt="" referrerPolicy="no-referrer" /> : <div className="profile-avatar">{authUser?.name.charAt(0).toUpperCase() || 'R'}</div>}
          <div className="profile-text"><strong>{authUser?.name || 'ReachInbox'}</strong><span>{authUser?.email || 'Workspace'}</span></div>
          {authUser && <button className="logout-button" type="button" onClick={() => void logout()}>Log out</button>}
        </div>
      </aside>

      <main className="main-content" id="dashboard">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-divider">/</span><strong>Campaigns</strong></div>
          <div className="topbar-actions">
            <span className={`connection-status connection-${apiStatus}`}><span />{apiStatus === 'connecting' ? 'Connecting…' : apiStatus === 'connected' ? 'API connected' : 'API unavailable'}</span>
            <button className="icon-button" type="button" onClick={() => void refreshDashboard()} aria-label="Refresh emails" title="Refresh"><RefreshIcon /></button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="page-heading">
            <div>
              <p className="eyebrow">YOUR OUTREACH, ORGANIZED</p>
              <h1>Email campaigns</h1>
              <p className="page-subtitle">Plan, schedule, and keep an eye on every email.</p>
            </div>
            <button className="button button-primary compose-button" type="button" onClick={openCompose}><PlusIcon /> Compose email</button>
          </section>

          {submitNotice && <div className="toast-success" role="status"><CheckIcon /> {submitNotice}</div>}
          {authError && authUser && <div className="auth-session-error" role="alert">{authError}</div>}

          <section className="stats-grid" aria-label="Email overview">
            <StatCard label="Scheduled" value={scheduled.length} helper="Emails in this view" icon={<ClockIcon />} accent="violet" />
            <StatCard label="Sent" value={sent.length} helper="Accepted by your SMTP server" icon={<SendIcon />} accent="green" />
            <StatCard label="Emails in view" value={scheduled.length + sent.length} helper="Across both tabs" icon={<PeopleIcon />} accent="blue" />
          </section>

          <section className="email-panel">
            <div className="panel-heading">
              <div>
                <h2>Email activity</h2>
                <p>See what is queued up and what has gone out.</p>
              </div>
              <button className="button button-secondary refresh-text" type="button" onClick={() => void refreshDashboard()} disabled={loading}><RefreshIcon /> Refresh</button>
            </div>

            <div className="tabs" role="tablist" aria-label="Email status">
              <button className={`tab ${activeTab === 'scheduled' ? 'tab-active' : ''}`} type="button" role="tab" aria-selected={activeTab === 'scheduled'} onClick={() => setActiveTab('scheduled')}>
                <ClockIcon /> Scheduled <span className="tab-count">{scheduled.length}</span>
              </button>
              <button className={`tab ${activeTab === 'sent' ? 'tab-active' : ''}`} type="button" role="tab" aria-selected={activeTab === 'sent'} onClick={() => setActiveTab('sent')}>
                <SendIcon /> Sent <span className="tab-count">{sent.length}</span>
              </button>
            </div>

            {loading ? <LoadingTable /> : currentError ? (
              <div className="state-panel state-error" role="alert">
                <div className="state-icon error-icon"><AlertIcon /></div>
                <h3>Could not load {activeTab} emails</h3>
                <p>{currentError}</p>
                <button className="button button-secondary" type="button" onClick={() => void refreshDashboard()}>Try again</button>
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="state-panel">
                <div className="state-icon"><EmptyIcon /></div>
                <h3>No {activeTab} emails yet</h3>
                <p>{activeTab === 'scheduled' ? 'Compose an email to start building your queue.' : 'Once your emails are accepted by SMTP, they will appear here.'}</p>
                {activeTab === 'scheduled' && <button className="button button-primary" type="button" onClick={openCompose}><PlusIcon /> Compose email</button>}
              </div>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="email-table">
                    <thead><tr><th>Recipient</th><th>Email</th><th>Sender</th><th>{activeTab === 'sent' ? 'Sent at' : 'Scheduled for'}</th><th>Status</th></tr></thead>
                    <tbody>{visibleRows.map((email) => <EmailRow key={email.id} email={email} tab={activeTab} />)}</tbody>
                  </table>
                </div>
                <div className="table-footer">
                  <span>Showing {visibleRows.length} {activeTab} {visibleRows.length === 1 ? 'email' : 'emails'}</span>
                  {nextCursor && <button className="button button-secondary" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
                </div>
              </>
            )}
          </section>

          <footer className="page-footer"><span>© {new Date().getFullYear()} ReachInbox</span><span>Scheduled with care <span className="footer-heart">♥</span></span></footer>
        </div>
      </main>

      {composeOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCompose() }}>
          <section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title">
            <header className="modal-header">
              <div><p className="eyebrow">NEW CAMPAIGN</p><h2 id="compose-title">Compose email</h2></div>
              <button className="icon-button" type="button" onClick={closeCompose} disabled={submitting} aria-label="Close compose dialog"><CloseIcon /></button>
            </header>
            <form onSubmit={(event) => void scheduleCampaign(event)}>
              <div className="modal-content-grid">
                <div className="compose-fields">
                  <label className="field-label" htmlFor="recipients">Recipients</label>
                  <div className="recipient-input-wrap">
                    <textarea id="recipients" rows={5} placeholder="alex@example.com, sam@example.com" value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} disabled={submitting || campaignAttempted} />
                    <label className="upload-button"><UploadIcon /> Upload CSV<input type="file" accept=".csv,text/csv" onChange={(event) => { void uploadCsv(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} disabled={submitting || campaignAttempted} /></label>
                  </div>
                  <div className="recipient-meta">
                    <span><strong>{recipients.valid.length}</strong> valid recipient{recipients.valid.length === 1 ? '' : 's'}</span>
                    {recipients.duplicates > 0 && <span>{recipients.duplicates} duplicate{recipients.duplicates === 1 ? '' : 's'} ignored</span>}
                    {recipients.invalid.length > 0 && <span className="invalid-count">{recipients.invalid.length} invalid</span>}
                  </div>
                  {recipients.invalid.length > 0 && <p className="inline-error">Check: {recipients.invalid.slice(0, 3).join(', ')}{recipients.invalid.length > 3 ? ` and ${recipients.invalid.length - 3} more` : ''}</p>}
                  {fileError && <p className="inline-error" role="alert">{fileError}</p>}

                  <label className="field-label" htmlFor="subject">Subject</label>
                  <input id="subject" className="text-input" type="text" maxLength={998} placeholder="A subject people will want to open" value={subject} onChange={(event) => setSubject(event.target.value)} disabled={submitting || campaignAttempted} />

                  <label className="field-label" htmlFor="body">Email body</label>
                  <textarea id="body" className="body-input" rows={7} placeholder="Write your email here…" value={body} onChange={(event) => setBody(event.target.value)} disabled={submitting || campaignAttempted} />
                </div>

                <aside className="schedule-settings">
                  <div className="settings-heading"><span className="settings-icon"><CalendarIcon /></span><div><h3>Schedule</h3><p>Choose when your emails go out.</p></div></div>
                  <label className="field-label" htmlFor="start-at">Start date &amp; time</label>
                  <input id="start-at" className="text-input" type="datetime-local" value={startAt} min={makeLocalDateTime(new Date())} onChange={(event) => setStartAt(event.target.value)} disabled={submitting || campaignAttempted} />

                  <label className="field-label" htmlFor="delay">Minimum delay</label>
                  <div className="input-with-suffix"><input id="delay" className="text-input" type="number" min="0" max="86400" step="1" value={delaySeconds} onChange={(event) => setDelaySeconds(event.target.value)} disabled={submitting || campaignAttempted} /><span>sec</span></div>

                  <label className="field-label" htmlFor="hourly-limit">Hourly sending limit</label>
                  <div className="input-with-suffix"><input id="hourly-limit" className="text-input" type="number" min="1" max="100000" step="1" value={hourlyLimit} onChange={(event) => setHourlyLimit(event.target.value)} disabled={submitting || campaignAttempted} /><span>/ hour</span></div>

                  <div className="schedule-note"><InfoIcon /><p>Campaign timing is spaced using these settings. The server’s sender-wide hourly limit remains the final safeguard.</p></div>
                </aside>
              </div>
              {submitError && <div className="form-error" role="alert"><AlertIcon /><span>{submitError}</span></div>}
              <footer className="modal-footer">
                <span className="modal-recipient-total">{recipients.valid.length} email{recipients.valid.length === 1 ? '' : 's'} will be scheduled</span>
                <div><button className="button button-secondary" type="button" onClick={closeCompose} disabled={submitting}>Cancel</button><button className="button button-primary" type="submit" disabled={submitting || !recipients.valid.length || recipients.invalid.length > 0}>{submitting ? <><SpinnerIcon /> Scheduling…</> : <><CalendarIcon /> {campaignAttempted ? 'Retry remaining' : 'Schedule emails'}</>}</button></div>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.'
}

function StatCard({ label, value, helper, icon, accent }: { label: string; value: number; helper: string; icon: React.ReactNode; accent: string }) {
  return <article className="stat-card"><div className={`stat-icon stat-${accent}`}>{icon}</div><div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{helper}</small></div></article>
}

function EmailRow({ email, tab }: { email: EmailRecord; tab: EmailTab }) {
  const statusClass = email.status.toLowerCase()
  return (
    <tr>
      <td><div className="recipient-cell"><div className="recipient-avatar">{email.recipient.charAt(0).toUpperCase()}</div><div><strong>{email.recipient}</strong><span>{email.sender.name || email.sender.email}</span></div></div></td>
      <td><div className="email-copy"><strong>{email.subject}</strong><span>{email.body.replace(/\s+/g, ' ').slice(0, 72)}{email.body.length > 72 ? '…' : ''}</span></div></td>
      <td><span className="sender-cell">{email.sender.email}</span></td>
      <td><span className="date-cell">{formatDate(tab === 'sent' ? email.smtpAcceptedAt : email.scheduledAt)}</span></td>
      <td><span className={`status-pill status-${statusClass}`}><span />{email.status === 'PROCESSING' ? 'Sending' : email.status.charAt(0) + email.status.slice(1).toLowerCase()}</span>{email.status === 'FAILED' && email.lastError && <span className="row-error" title={email.lastError}>{email.lastError}</span>}</td>
    </tr>
  )
}

function LoadingTable() {
  return <div className="loading-table" aria-label="Loading emails" aria-live="polite"><span className="sr-only">Loading emails…</span>{Array.from({ length: 5 }, (_, index) => <div className="skeleton-row" key={index}><span /><span /><span /></div>)}</div>
}

function BrandIcon() { return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 9.2 27 4l-8.2 23-4.2-9.8L5 9.2Z" /><path d="m14.6 17.2 6.5-7.1" /></svg> }
function GridIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></svg> }
function SendIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.2 18-3.7-7.1L3 10.2 21 3Z" /><path d="m10.1 13.9 4.2-4.2" /></svg> }
function PeopleIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8" /></svg> }
function SparkleIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> }
function UploadIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" /></svg> }
function CalendarIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M7.5 3v4M16.5 3v4M4 9.5h16" /></svg> }
function InfoIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg> }
function AlertIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 17H3l9-17Z" /><path d="M12 9v5M12 17h.01" /></svg> }
function EmptyIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9h16M8 13h3M8 16h6" /></svg> }
function CloseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg> }
function SpinnerIcon() { return <svg className="spinner-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /></svg> }
