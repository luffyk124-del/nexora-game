import { useEffect, useState } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '../../lib/firebase';

const SUPABASE_URL = 'https://dmeupqmhsyojxlgalxrc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PCsjX_kcS-D8FY4PobPl4w_2BwpeilC';

const COLLECTIONS = [
  'profiles',
  'usernames',
  'users_private',
  'wallets',
  'transactions',
  'inventory',
  'market_listings',
  'companies',
  'organizations',
  'conversations',
  'market_orders',
  'company_auctions',
  'company_logs',
  'properties',
  'organization_members',
  'organization_requests',
  'organization_transactions',
  'player_missions',
  'daily_claims',
  'contract_claims',
  'player_achievements',
  'notifications',
  'world_events',
  'audit_logs',
  'user_blocks',
  'chat_rate_limits',
  'global_chat_messages',
  'organization_invites',
  'player_reports',
] as const;

type ExportDocument = { id: string; path: string; fields: Record<string, unknown> };
type ExportPage = {
  ok: boolean;
  collection: string;
  count: number;
  documents: ExportDocument[];
  nextPageToken: string | null;
  hasMore: boolean;
  error?: string;
};
type RunMode = 'scan' | 'import';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MigrationConsole() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<RunMode | null>(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [importComplete, setImportComplete] = useState(false);
  const [currentTask, setCurrentTask] = useState('');
  const [totalDocuments, setTotalDocuments] = useState(0);
  const [importedDocuments, setImportedDocuments] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setAuthReady(true);
    });
    getRedirectResult(auth).catch((error) => {
      if (active) setAuthError(errorMessage(error));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setScanComplete(false);
    setImportComplete(false);
    setCounts({});
    setLogs([]);
    setFailure('');
  }, [user?.uid]);

  const addLog = (message: string) => {
    setLogs((previous) => [...previous.slice(-79), message]);
  };

  async function signIn() {
    setAuthError('');
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, googleAuthProvider);
        return;
      }
      setAuthError(errorMessage(error));
    }
  }

  async function verifyOwnerSession(activeUser: User): Promise<void> {
    await activeUser.reload();
    if (activeUser.isAnonymous || !activeUser.emailVerified) {
      throw new Error('يجب تسجيل الدخول بحساب موثّق البريد، ولا يمكن استخدام حساب ضيف.');
    }
  }

  async function exportPage(
    activeUser: User,
    collection: string,
    parentId: string,
    pageToken: string,
  ): Promise<ExportPage> {
    const token = await activeUser.getIdToken();
    const response = await fetch('/api/migration-export', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        collection,
        parentId: parentId || undefined,
        pageSize: 100,
        pageToken: pageToken || undefined,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error('تصدير ' + collection + ' فشل: ' + (result.error || ('HTTP ' + response.status)));
    }
    return result as ExportPage;
  }

  async function importPage(
    activeUser: User,
    collection: string,
    parentId: string,
    documents: ExportDocument[],
  ): Promise<number> {
    if (!documents.length) return 0;
    const token = await activeUser.getIdToken();
    const response = await fetch(SUPABASE_URL + '/functions/v1/nexora-migration-import', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        collection,
        parentId: parentId || undefined,
        documents,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error('استيراد ' + collection + ' فشل: ' + (result.error || ('HTTP ' + response.status)));
    }
    return Number(result.imported ?? documents.length);
  }

  async function runMigration(mode: RunMode) {
    if (!user || running) return;
    setRunning(true);
    setRunMode(mode);
    setFailure('');
    setCurrentTask('');
    setTotalDocuments(0);
    setImportedDocuments(0);
    setCounts({});
    setLogs([]);
    if (mode === 'scan') {
      setScanComplete(false);
      setImportComplete(false);
    } else {
      setImportComplete(false);
    }

    try {
      await verifyOwnerSession(user);
      const conversationIds: string[] = [];
      let total = 0;
      let imported = 0;

      for (const collection of COLLECTIONS) {
        setCurrentTask(collection);
        let pageToken = '';
        let collectionCount = 0;

        do {
          const page = await exportPage(user, collection, '', pageToken);
          const documents = Array.isArray(page.documents) ? page.documents : [];
          collectionCount += documents.length;
          total += documents.length;
          setTotalDocuments(total);

          if (collection === 'conversations') {
            for (const document of documents) {
              if (document.id && !conversationIds.includes(document.id)) conversationIds.push(document.id);
            }
          }

          if (mode === 'import' && documents.length) {
            imported += await importPage(user, collection, '', documents);
            setImportedDocuments(imported);
          }

          pageToken = page.nextPageToken || '';
        } while (pageToken);

        setCounts((previous) => ({ ...previous, [collection]: collectionCount }));
        addLog(collection + ': ' + collectionCount + ' سجل');
      }

      setCurrentTask('conversation_messages');
      let messageCount = 0;
      for (let index = 0; index < conversationIds.length; index += 1) {
        const parentId = conversationIds[index];
        let pageToken = '';
        let parentCount = 0;
        do {
          const page = await exportPage(user, 'conversation_messages', parentId, pageToken);
          const documents = Array.isArray(page.documents) ? page.documents : [];
          parentCount += documents.length;
          messageCount += documents.length;
          total += documents.length;
          setTotalDocuments(total);

          if (mode === 'import' && documents.length) {
            imported += await importPage(user, 'conversation_messages', parentId, documents);
            setImportedDocuments(imported);
          }
          pageToken = page.nextPageToken || '';
        } while (pageToken);
        if (parentCount > 0) addLog('رسائل محادثة ' + (index + 1) + ': ' + parentCount);
      }

      setCounts((previous) => ({ ...previous, conversation_messages: messageCount }));
      addLog('conversation_messages: ' + messageCount + ' سجل');
      setImportedDocuments(imported);

      if (mode === 'scan') {
        setScanComplete(true);
        addLog('اكتمل الفحص دون كتابة أي بيانات في Supabase.');
      } else {
        setImportComplete(true);
        addLog('اكتمل استيراد الدفعات إلى nexora. Firebase ما زال المصدر النشط.');
      }
    } catch (error) {
      const message = errorMessage(error);
      setFailure(message);
      addLog('توقف التنفيذ: ' + message);
    } finally {
      setRunning(false);
      setCurrentTask('');
    }
  }

  if (!authReady) {
    return <main className="min-h-screen bg-[#0B0D12] text-white flex items-center justify-center p-6">جارٍ التحقق من جلسة Firebase…</main>;
  }

  return (
    <main dir="rtl" className="min-h-screen bg-[#0B0D12] text-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="rounded-2xl border border-slate-700 bg-[#141821] p-5">
          <p className="text-xs font-semibold tracking-[0.2em] text-cyan-300">NEXORA / MIGRATION CONTROL</p>
          <h1 className="mt-2 text-2xl font-bold">مركز نقل بيانات NEXORA</h1>
          <p className="mt-2 text-sm leading-7 text-slate-300">
            أداة إدارية محمية لنقل نسخة من بيانات Firestore إلى schema nexora فقط.
            لن تحذف بيانات Firebase ولن تبدّل اللعبة إلى Supabase.
          </p>
        </header>

        {!user ? (
          <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-4">
            <h2 className="text-lg font-semibold">تسجيل دخول المالك</h2>
            <p className="text-sm text-slate-300">سجّل الدخول بحساب Firebase نفسه الذي أرسلنا UID الخاص به. التحقق النهائي من صلاحية المالك يتم على الخادم.</p>
            <button onClick={signIn} className="w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950">تسجيل الدخول عبر Google</button>
            {authError && <p className="text-sm text-rose-300">{authError}</p>}
          </section>
        ) : (
          <>
            <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">جلسة Firebase الحالية</h2>
                  <p className="mt-1 text-sm text-slate-300">{user.email || 'بدون بريد إلكتروني'}</p>
                  <p className="mt-1 break-all text-xs text-slate-500">UID: {user.uid}</p>
                </div>
                <button onClick={() => signOut(auth)} disabled={running} className="rounded-lg border border-slate-600 px-3 py-2 text-sm">تسجيل الخروج</button>
              </div>
              {!user.emailVerified && <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">يجب توثيق البريد الإلكتروني لهذا الحساب أولاً.</p>}
            </section>

            <section className="rounded-2xl border border-cyan-500/40 bg-[#141821] p-5 space-y-3">
              <h2 className="text-lg font-semibold text-cyan-200">المصدّر الجديد عبر GitHub Actions</h2>
              <p className="text-sm leading-7 text-slate-300">
                أُضيف مسار تصدير جديد يستخدم GitHub OIDC بدل اعتماد تشغيل التصدير على Vercel.
                يحتاج إعداد Workload Identity Federation في Google Cloud ومتغير المستودع الموضحين في دليل الإعداد.
                شغّل وضع scan أولاً، ولا تشغّل المسارين بالتوازي.
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <a className="underline text-cyan-200" href="https://github.com/luffyk124-del/nexora-game/blob/feature/nexora-social-economy-mobile-overhaul/docs/GITHUB_OIDC_SETUP.md" target="_blank" rel="noreferrer">دليل إعداد GitHub OIDC</a>
                <a className="underline text-cyan-200" href="https://github.com/luffyk124-del/nexora-game/blob/feature/nexora-social-economy-mobile-overhaul/.github/workflows/nexora-firestore-export.yml" target="_blank" rel="noreferrer">ملف مهمة التصدير الجديدة</a>
              </div>
              <p className="text-xs leading-6 text-slate-400">
                ستظهر إمكانية تشغيل المهمة من تبويب Actions بعد وصول ملف workflow إلى الفرع الافتراضي. يبقى المصدّر الحالي احتياطياً فقط حتى نجاح أول فحص واستيراد عبر GitHub.
              </p>
            </section>

            <section className="rounded-2xl border border-amber-500/30 bg-[#141821] p-5 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">المصدّر الاحتياطي القديم (Vercel)</h2>
                <p className="mt-1 text-sm leading-6 text-slate-300">هذا المسار مؤقت للرجوع فقط. استخدمه فقط عند تعذر مسار GitHub الجديد، ولا تشغّل التصديرين معاً. الفحص يقرأ المصدر فقط، والاستيراد يستخدم checksum وupsert.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  onClick={() => runMigration('scan')}
                  disabled={running || !user.emailVerified || user.isAnonymous}
                  className="rounded-xl border border-cyan-400/60 px-4 py-3 font-semibold text-cyan-200 disabled:opacity-40"
                >
                  {running && runMode === 'scan' ? 'جارٍ فحص Firestore…' : '1) فحص المصدر فقط'}
                </button>
                <button
                  onClick={() => runMigration('import')}
                  disabled={running || !scanComplete || !user.emailVerified || user.isAnonymous}
                  className="rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-40"
                >
                  {running && runMode === 'import' ? 'جارٍ الاستيراد…' : '2) استيراد البيانات إلى NEXORA'}
                </button>
              </div>
              {scanComplete && <p className="text-sm text-emerald-300">نجح فحص المصدر. يمكنك بدء الاستيراد.</p>}
              {importComplete && <p className="text-sm text-emerald-300">اكتمل استيراد الدفعات. يلزم بعده فحص المطابقة والوظائف قبل أي تحويل للتشغيل.</p>}
              {failure && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{failure}</p>}
            </section>

            {(running || logs.length > 0) && (
              <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5 space-y-3">
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <span className="text-slate-300">المهمة الحالية: {currentTask || '—'}</span>
                  <span className="tabular-nums">السجلات المفحوصة: {totalDocuments.toLocaleString('en-US')}</span>
                </div>
                {runMode === 'import' && <p className="text-sm text-cyan-200">السجلات المستوردة/المؤكدة: {importedDocuments.toLocaleString('en-US')}</p>}
                <div className="max-h-72 space-y-2 overflow-auto rounded-xl bg-[#0B0D12] p-3 text-xs">
                  {logs.map((line, index) => <p key={index} className="text-slate-300">{line}</p>)}
                </div>
              </section>
            )}

            {Object.keys(counts).length > 0 && (
              <section className="rounded-2xl border border-slate-700 bg-[#141821] p-5">
                <h2 className="mb-3 font-semibold">ملخص المجموعات</h2>
                <div className="divide-y divide-slate-700">
                  {Object.entries(counts).map(([name, count]) => (
                    <div key={name} className="flex justify-between gap-4 py-2 text-sm">
                      <span className="text-slate-300">{name}</span>
                      <span className="font-mono tabular-nums">{count.toLocaleString('en-US')}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
        <footer className="text-center text-xs leading-6 text-slate-500">
          لا تُغلق الصفحة أثناء التنفيذ. إذا انقطع الاتصال، أعد تشغيل الاستيراد؛ الدفعات السابقة قابلة للتكرار.
        </footer>
      </div>
    </main>
  );
}
