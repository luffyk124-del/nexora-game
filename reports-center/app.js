import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.0';

const SUPABASE_URL = 'https://dmeupqmhsyojxlgalxrc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PCsjX_kcS-D8FY4PobPl4w_2BwpeilC';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (id) => document.getElementById(id);
let currentStatus = 'all', reports = [], auditEntries = [], view = 'reports', searchTerm = '';

$('loginBtn').onclick = async () => {
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { prompt: 'select_account' } }
    });
    if (error) throw error;
  } catch (error) {
    $('loginError').textContent = 'تعذر بدء تسجيل الدخول عبر Google. تحقق من تفعيل مزود Google في إعدادات Supabase.';
    $('loginBtn').disabled = false;
  }
};

$('logoutBtn').onclick = async () => { await supabase.auth.signOut(); };
supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    $('login').hidden = false; $('dashboard').hidden = true; $('loginBtn').disabled = false; return;
  }
  $('login').hidden = true; $('dashboard').hidden = false;
  loadReports();
});

async function adminCall(payload) {
  const { data, error } = await supabase.functions.invoke('nexora-reports-admin', { body: payload });
  if (error) {
    const context = error.context;
    if (context && typeof context.json === 'function') {
      const detail = await context.json().catch(() => ({}));
      if (detail.error === 'REPORTS_ADMIN_REQUIRED') throw new Error('REPORTS_ADMIN_REQUIRED');
    }
    throw error;
  }
  return data;
}

async function loadReports() {
  view = 'reports'; $('auditBtn').textContent = 'سجل إجراءات المشرفين';
  $('search').hidden = false; $('filters').hidden = false; $('notice').textContent = 'جارٍ تحميل البلاغات…';
  try {
    const result = await adminCall({ action: 'list', status: currentStatus, limit: 100 });
    reports = result.reports || []; render();
    $('notice').textContent = 'تم تحميل ' + reports.length + ' بلاغ.';
  } catch (error) {
    if (String(error.message).includes('REPORTS_ADMIN_REQUIRED')) {
      $('notice').textContent = 'تم تسجيل الدخول، لكن هذا الحساب غير مضاف إلى قائمة مشرفي NEXORA بعد.';
      return;
    }
    $('notice').textContent = 'تعذر تحميل البلاغات. تحقق من إعدادات Google Auth والاتصال.';
  }
}
async function loadAudit() {
  view = 'audit'; $('auditBtn').textContent = 'العودة إلى البلاغات';
  $('search').hidden = true; $('filters').hidden = true; $('notice').textContent = 'جارٍ تحميل سجل الإجراءات…';
  try {
    const result = await adminCall({ action: 'audit', limit: 100 });
    auditEntries = result.entries || []; renderAudit();
    $('notice').textContent = 'تم تحميل ' + auditEntries.length + ' إجراء.';
  } catch { $('notice').textContent = 'تعذر تحميل سجل الإجراءات.'; }
}
function render() {
  const visible = reports.filter(r => [r.id, r.reporterUid, r.targetUid, r.reason].join(' ').toLowerCase().includes(searchTerm));
  const count = status => reports.filter(r => r.status === status).length;
  $('summary').innerHTML = [['المفتوحة',count('open')],['قيد المراجعة',count('reviewing')],['المغلقة',count('closed')]].map(([name,value]) => '<div class="stat"><b>'+value+'</b><span>'+name+'</span></div>').join('');
  $('reports').innerHTML = visible.map(r => {
    const reason = {harassment:'مضايقة أو إساءة',spam:'رسائل مزعجة',inappropriate:'محتوى غير مناسب',impersonation:'انتحال شخصية',other:'سبب آخر'}[r.reason] || r.reason;
    const date = r.createdAt ? new Date(r.createdAt).toLocaleString('ar') : 'غير معروف';
    return '<article class="report"><div class="reporttop"><b>بلاغ #'+escapeHtml(String(r.id).slice(-10))+'</b><span class="tag">'+({open:'مفتوح',reviewing:'قيد المراجعة',closed:'مغلق'}[r.status]||r.status)+'</span></div><div>'+escapeHtml(reason)+'</div><div class="meta">المبلّغ: '+escapeHtml(r.reporterUid)+'<br>اللاعب المبلّغ عنه: '+escapeHtml(r.targetUid)+'<br>التاريخ: '+escapeHtml(date)+'</div><div class="actions">'+(r.status!=='reviewing'?'<button class="action" data-id="'+escapeHtml(r.id)+'" data-next="reviewing">قيد المراجعة</button>':'')+(r.status!=='closed'?'<button class="action" data-id="'+escapeHtml(r.id)+'" data-next="closed">إغلاق البلاغ</button>':'')+(r.status!=='open'?'<button class="action" data-id="'+escapeHtml(r.id)+'" data-next="open">إعادة فتح</button>':'')+'</div></article>';
  }).join('') || '<div class="panel">لا توجد بلاغات في هذا التصنيف.</div>';
  document.querySelectorAll('[data-next]').forEach(button => button.onclick = () => updateReport(button.dataset.id, button.dataset.next));
}
function renderAudit() {
  $('summary').innerHTML = '';
  $('reports').innerHTML = auditEntries.map(entry => '<article class="audit-entry"><b>'+escapeHtml(entry.action || 'إجراء إداري')+'</b><div class="meta">البلاغ: '+escapeHtml(entry.reportId)+'<br>المشرف: '+escapeHtml(entry.actorUid)+'<br>الحالة الجديدة: '+escapeHtml(entry.newStatus || '—')+'<br>التاريخ: '+escapeHtml(entry.createdAt ? new Date(entry.createdAt).toLocaleString('ar') : 'غير معروف')+'</div></article>').join('') || '<div class="panel">لا توجد إجراءات مسجلة بعد.</div>';
}
async function updateReport(reportId, status) {
  $('notice').textContent = 'جارٍ حفظ التغيير…';
  try { await adminCall({ action: 'update', reportId, status }); await loadReports(); }
  catch { $('notice').textContent = 'تعذر تحديث البلاغ.'; }
}
document.querySelectorAll('#filters button').forEach(button => button.onclick = () => {
  currentStatus = button.dataset.status;
  document.querySelectorAll('#filters button').forEach(item => item.classList.toggle('active', item === button));
  loadReports();
});
$('auditBtn').onclick = () => view === 'audit' ? loadReports() : loadAudit();
$('search').oninput = event => { searchTerm = event.target.value.toLowerCase(); if (view === 'reports') render(); };
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
