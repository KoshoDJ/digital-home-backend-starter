'use client';

/**
 * Social accounts — connect the identities the engine publishes through.
 * One Meta OAuth grabs the Facebook page AND its linked Instagram business
 * account; YouTube connects per channel. Each has a manual-token fallback
 * for when the OAuth apps aren't configured yet.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  EmptyState,
  Field,
  GhostBtn,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  StatusDot,
  TextArea,
  timeAgo,
  useToast,
} from '@/components/crm/kit';
import { type AccountRow, PLATFORM_META, PlatformBadge, SocialNav } from '../social-kit';

const ACCOUNT_STATUS_DOTS: Record<string, string> = {
  active: 'bg-green-500',
  error: 'bg-red-500',
  disconnected: 'bg-zinc-600',
};

function ManualConnectModal({
  kind,
  onClose,
  onDone,
  show,
}: {
  kind: 'meta' | 'youtube';
  onClose: () => void;
  onDone: () => void;
  show: (t: string, k?: 'ok' | 'err') => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ connected: string[] }>('/api/social/accounts', {
        method: 'POST',
        body: JSON.stringify(
          kind === 'meta'
            ? { platform: 'meta', page_token: token.trim() }
            : { platform: 'youtube', refresh_token: token.trim() }
        ),
      });
      show(`Connected: ${res.connected.join(' · ')}`);
      onDone();
      onClose();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Connect failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === 'meta' ? 'Connect with a page token' : 'Connect with a refresh token'}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">
          {kind === 'meta' ? (
            <>
              Paste a long-lived <strong>Page access token</strong> for the brand page (Graph API
              Explorer → your app → Page token with instagram_content_publish +
              pages_manage_posts). This connects the Facebook page and its linked Instagram
              business account in one go.
            </>
          ) : (
            <>
              Paste a Google OAuth <strong>refresh token</strong> with the youtube.upload scope.
              Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the worker to mint access
              tokens.
            </>
          )}
        </p>
        <Field label={kind === 'meta' ? 'Page access token' : 'Refresh token'}>
          <TextArea rows={3} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={submit} disabled={busy || !token.trim()}>
            {busy ? 'Validating…' : 'Connect'}
          </PrimaryBtn>
        </div>
      </div>
    </Modal>
  );
}

export default function SocialAccountsPage() {
  const { show, node: toastNode } = useToast();
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [oauth, setOauth] = useState({ meta: false, google: false });
  const [manual, setManual] = useState<'meta' | 'youtube' | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{
        accounts: AccountRow[];
        oauth: { meta: boolean; google: boolean };
        can_manage: boolean;
      }>('/api/social/accounts');
      setAccounts(res.accounts);
      setOauth(res.oauth);
      setCanManage(res.can_manage);
      setLoadError(null);
    } catch (e) {
      // Never fall through to the empty state here: an unreadable list looked
      // exactly like "nothing is connected", which sent people to the manual
      // token modal for accounts that were already live.
      const msg = e instanceof Error ? e.message : 'Failed to load — has migration 019 been applied?';
      show(msg, 'err');
      setLoadError(msg);
      setAccounts([]);
    }
  }, [show]);

  useEffect(() => {
    load();
    // Surface the OAuth redirect outcome, then clean the URL.
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) show(`Connected ${params.get('connected')} account(s) ✓`);
    if (params.get('error')) show(params.get('error') || 'Connection failed', 'err');
    if (params.get('connected') || params.get('error')) {
      window.history.replaceState({}, '', '/social/accounts');
    }
  }, [load, show]);

  const disconnect = async (a: AccountRow) => {
    if (!confirm(`Disconnect ${a.name}? Published history stays; new posts can't target it.`)) return;
    try {
      await api(`/api/social/accounts/${a.id}`, { method: 'DELETE' });
      show('Disconnected');
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Disconnect failed', 'err');
    }
  };

  if (accounts === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Social" />
        <SocialNav />
        <Loading />
      </div>
    );
  }

  const visible = accounts.filter((a) => a.status !== 'disconnected');

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Social">
        {canManage && (
          <>
            <GhostBtn
              onClick={() =>
                oauth.meta ? (window.location.href = '/api/social/oauth/meta') : setManual('meta')
              }
            >
              Connect Instagram + Facebook
            </GhostBtn>
            <GhostBtn
              onClick={() =>
                oauth.google
                  ? (window.location.href = '/api/social/oauth/google')
                  : setManual('youtube')
              }
            >
              Connect YouTube
            </GhostBtn>
          </>
        )}
      </PageHeader>
      <SocialNav />

      <div className="flex-1 overflow-y-auto px-12 py-8">
        {loadError && (
          <div className="mb-6 px-4 py-3 border border-red-900/60 bg-red-950/30 rounded-lg text-[13px] text-red-300 leading-relaxed">
            Couldn&apos;t load the connected accounts: {loadError}
          </div>
        )}

        {canManage && !oauth.meta && !oauth.google && (
          <div className="mb-6 px-4 py-3 border border-minimal-border rounded-lg text-[13px] text-zinc-400 leading-relaxed">
            OAuth apps aren&apos;t configured yet, so the connect buttons fall back to manual token
            entry. To enable one-click connects, set <code>META_APP_ID</code> /{' '}
            <code>META_APP_SECRET</code> and <code>GOOGLE_CLIENT_ID</code> /{' '}
            <code>GOOGLE_CLIENT_SECRET</code> as worker secrets — full walkthrough in SOCIAL.md.
          </div>
        )}

        {loadError ? null : visible.length === 0 ? (
          <EmptyState
            title="No accounts connected"
            hint={
              canManage
                ? "Connect the brand's Instagram business account (via its Facebook page) and the YouTube channel to start distributing."
                : 'Ask an admin to connect the brand accounts — this login can publish through them but not connect them.'
            }
          />
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl">
            {visible.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-4 px-5 py-4 border border-minimal-border rounded-xl"
              >
                <PlatformBadge platform={a.platform} />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-white truncate">
                    {a.username ? `@${a.username}` : a.name}
                  </div>
                  <div className="text-[12px] text-zinc-500">
                    {PLATFORM_META[a.platform].label} · connected {timeAgo(a.connected_at)}
                  </div>
                </div>
                <StatusDot status={a.status} map={ACCOUNT_STATUS_DOTS} />
                {canManage && (
                  <GhostBtn danger onClick={() => disconnect(a)}>
                    Disconnect
                  </GhostBtn>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {manual && (
        <ManualConnectModal
          kind={manual}
          onClose={() => setManual(null)}
          onDone={load}
          show={show}
        />
      )}
    </div>
  );
}
