// "Open SerieX Books": opens the SerieX Books web client of the linked company file in a
// new browser tab (company menu, navigation, Home page, Books Sync window). The File menu's
// "Switch to SerieX Books..." (AppSwitcher.tsx) opens it in this tab instead.
import { api } from '@/api/client';
import { alertBox } from '@/components/dialogs';
import { queryClient } from '@/api/hooks';
import { useSession, APP_NAME } from '@/state/session';

function known(): string {
  const s = useSession.getState();
  const cached = queryClient.getQueryData<string>(['shell', 'books-url', s.companyId]);
  return cached || s.company?.booksUrl || '';
}

/** Opens SerieX Books in a new tab. The tab is opened at once (popup blockers) and pointed at the address when known. */
export function openSerieXBooks(): void {
  const url = known();
  if (url) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const w = window.open('about:blank', '_blank');
  const fetchUrl = useSession.getState().companyId
    ? api.get<{ url: string }>('/books/open-url', { noPrompt: true }).then((r) => r?.url ?? '')
    : api.global.get<{ booksUrl: string }>('/info', { noPrompt: true }).then((r) => r?.booksUrl ?? '');
  fetchUrl
    .then((u) => {
      if (!u) throw new Error('The SerieX Books address is not known.');
      if (w) {
        w.opener = null;
        w.location.href = u;
      } else window.open(u, '_blank', 'noopener');
    })
    .catch((e) => {
      w?.close();
      void alertBox(`SerieX Books could not be opened.\n\n${e instanceof Error ? e.message : String(e)}`, APP_NAME, 'warning');
    });
}
