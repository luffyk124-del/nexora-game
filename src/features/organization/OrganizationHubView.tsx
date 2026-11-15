import { ArrowUpCircle, Building2, Check, Plus, Shield, UserMinus, Users, Vault, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/ToastProvider';
import { ORG_CREATION_COST, ROLE_DEFAULT_PERMISSIONS } from '../../data/catalog';
import { useTranslations, formatOrgRole } from '../../i18n/translations';
import {
  calculateOrgUpgradeCost,
  canManageOrgMember,
  hasOrgPermission,
  ORG_MAX_LEVEL,
  sanitizePositiveInt,
} from '../../lib/economy';
import {
  createOrganization,
  depositToOrgTreasury,
  handleOrgJoinRequest,
  kickOrgMember,
  leaveOrganization,
  requestJoinOrganization,
  updateOrgMemberRole,
  upgradeOrganization,
  withdrawFromOrgTreasury,
} from '../../services/gameService';
import type {
  Language,
  Organization,
  OrganizationMember,
  OrganizationRequest,
  OrganizationTransaction,
  OrgRole,
  PlayerProfile,
  Wallet,
} from '../../types/game';

interface OrganizationHubViewProps {
  profile: PlayerProfile;
  wallet: Wallet | null;
  organizations: Organization[];
  myOrgMember: OrganizationMember | null;
  orgMembers: OrganizationMember[];
  orgRequests: OrganizationRequest[];
  myPendingOrgIds: Set<string>;
  orgTransactions: OrganizationTransaction[];
  language: Language;
}

export function OrganizationHubView({
  profile,
  wallet,
  organizations,
  myOrgMember,
  orgMembers,
  orgRequests,
  myPendingOrgIds,
  orgTransactions,
  language,
}: OrganizationHubViewProps) {
  const t = useTranslations(language);
  const { showToast } = useToast();

  const [orgName, setOrgName] = useState('');
  const [orgTag, setOrgTag] = useState('');
  const [orgDesc, setOrgDesc] = useState('');
  const [treasuryAmt, setTreasuryAmt] = useState(100);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const [kickTarget, setKickTarget] = useState<{ uid: string; username: string } | null>(null);

  const currentOrg = myOrgMember
    ? organizations.find((o) => o.id === myOrgMember.orgId) || null
    : null;

  const canManageMembers = hasOrgPermission(myOrgMember, 'manage_members');
  const canManageRoles = hasOrgPermission(myOrgMember, 'manage_roles');
  const canManageTreasury = hasOrgPermission(myOrgMember, 'manage_treasury');
  const canManageOrg = hasOrgPermission(myOrgMember, 'manage_org');

  const contributionsByUid = new Map<string, number>();
  for (const otx of orgTransactions) {
    if (otx.type === 'deposit') {
      contributionsByUid.set(otx.uid, (contributionsByUid.get(otx.uid) || 0) + otx.amount);
    }
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setBusyKey('create_org');
    try {
      await createOrganization(profile.uid, profile.username, orgName, orgTag, orgDesc);
      setOrgName('');
      setOrgTag('');
      setOrgDesc('');
      showToast(
        language === 'ar' ? 'تم تأسيس المنظمة بنجاح!' : 'Organization founded!',
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'INSUFFICIENT_FUNDS'
          ? language === 'ar'
            ? `يتطلب التأسيس ${ORG_CREATION_COST} N-Credits.`
            : `Founding requires ${ORG_CREATION_COST} N-Credits.`
          : language === 'ar'
          ? 'تأكد من صحة الاسم والرمز.'
          : 'Check organization name and tag.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRequestJoin(orgId: string) {
    setBusyKey(`join_${orgId}`);
    try {
      await requestJoinOrganization(profile.uid, profile.username, orgId);
      showToast(
        language === 'ar' ? 'تم إرسال طلب الانضمام للإدارة.' : 'Join request sent to leadership.',
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'REQUEST_ALREADY_PENDING'
          ? language === 'ar'
            ? 'لديك طلب انضمام قيد المراجعة لهذه المنظمة بالفعل.'
            : 'You already have a pending request for this organization.'
          : code === 'ALREADY_IN_ORG'
          ? language === 'ar'
            ? 'أنت عضو في منظمة أخرى بالفعل.'
            : 'You are already a member of an organization.'
          : language === 'ar'
          ? 'تعذر إرسال الطلب.'
          : 'Could not submit request.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleJoinDecision(
    req: OrganizationRequest,
    decision: 'approved' | 'rejected'
  ) {
    if (!currentOrg) return;
    setBusyKey(`req_${req.id}`);
    try {
      await handleOrgJoinRequest(currentOrg.id, req.id, req.uid, req.username, decision);
      showToast(
        decision === 'approved'
          ? language === 'ar'
            ? `تم قبول ${req.username} في المنظمة.`
            : `${req.username} approved.`
          : language === 'ar'
          ? `تم رفض طلب ${req.username}.`
          : `Request from ${req.username} rejected.`,
        decision === 'approved' ? 'success' : 'info'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'REQUEST_ALREADY_HANDLED'
          ? language === 'ar'
            ? 'تمت معالجة هذا الطلب مسبقاً.'
            : 'This request has already been handled.'
          : code === 'ALREADY_ORG_MEMBER'
          ? language === 'ar'
            ? 'اللاعب عضو في هذه المنظمة بالفعل.'
            : 'Player is already a member.'
          : code === 'APPLICANT_IN_OTHER_ORG'
          ? language === 'ar'
            ? 'اللاعب انضم بالفعل إلى منظمة أخرى.'
            : 'Applicant already joined another organization.'
          : code === 'ORG_FULL'
          ? language === 'ar'
            ? 'وصلت المنظمة إلى الحد الأقصى للأعضاء.'
            : 'Organization has reached member capacity.'
          : language === 'ar'
          ? 'تعذر تنفيذ القرار.'
          : 'Could not process request.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeposit() {
    if (!currentOrg) return;
    setBusyKey('dep');
    try {
      await depositToOrgTreasury(profile.uid, profile.username, currentOrg.id, treasuryAmt);
      showToast(
        language === 'ar' ? 'تم الإيداع في خزينة المنظمة.' : 'Deposited to organization treasury.',
        'success'
      );
    } catch {
      showToast(language === 'ar' ? 'الرصيد غير كافٍ.' : 'Insufficient personal funds.', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleWithdraw() {
    if (!currentOrg) return;
    setBusyKey('wdr');
    try {
      await withdrawFromOrgTreasury(profile.uid, profile.username, currentOrg.id, treasuryAmt);
      showToast(
        language === 'ar' ? 'تم السحب من خزينة المنظمة.' : 'Withdrawn from treasury.',
        'success'
      );
    } catch {
      showToast(
        language === 'ar' ? 'تعذر السحب من الخزينة.' : 'Withdrawal failed or unauthorized.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRoleChange(targetUid: string, nextRole: Exclude<OrgRole, 'leader'>) {
    if (!currentOrg) return;
    setBusyKey(`role_${targetUid}`);
    try {
      await updateOrgMemberRole(currentOrg.id, targetUid, nextRole);
      showToast(language === 'ar' ? 'تم تحديث الرتبة والصلاحيات.' : 'Member role updated.', 'success');
    } catch {
      showToast(language === 'ar' ? 'ليس لديك صلاحية تعديل الرتب.' : 'Permission denied.', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleLeave() {
    if (!currentOrg) return;
    setBusyKey('leave');
    try {
      await leaveOrganization(profile.uid, currentOrg.id);
      setConfirmLeaveOpen(false);
      showToast(language === 'ar' ? 'غادرت المنظمة.' : 'Left organization.', 'info');
    } catch {
      showToast(
        language === 'ar'
          ? 'لا يمكن لرئيس المنظمة المغادرة قبل نقل القيادة.'
          : 'Leader cannot leave organization directly.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleUpgradeOrg() {
    if (!currentOrg) return;
    setBusyKey('upgrade_org');
    try {
      const nextLv = await upgradeOrganization(profile.uid, profile.username, currentOrg.id);
      showToast(
        language === 'ar'
          ? `تمت ترقية المنظمة إلى المستوى ${nextLv} (+25 سمعة).`
          : `Organization upgraded to Lv.${nextLv} (+25 Rep).`,
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'INSUFFICIENT_TREASURY'
          ? language === 'ar'
            ? 'رصيد خزينة المنظمة غير كافٍ للترقية.'
            : 'Insufficient organization treasury funds.'
          : code === 'MAX_LEVEL'
          ? t.maxLevelReached
          : language === 'ar'
          ? 'تعذر ترقية المنظمة.'
          : 'Could not upgrade organization.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleConfirmKick() {
    if (!currentOrg || !kickTarget) return;
    setBusyKey(`kick_${kickTarget.uid}`);
    try {
      await kickOrgMember(profile.uid, currentOrg.id, kickTarget.uid);
      showToast(
        language === 'ar'
          ? `تمت إزالة ${kickTarget.username} من المنظمة.`
          : `Removed ${kickTarget.username} from organization.`,
        'info'
      );
      setKickTarget(null);
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'RANK_TOO_HIGH' || code === 'UNAUTHORIZED'
          ? language === 'ar'
            ? 'رتبتك لا تسمح بإزالة هذا العضو.'
            : 'Your rank cannot remove this member.'
          : language === 'ar'
          ? 'تعذر إزالة العضو.'
          : 'Failed to remove member.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  if (!myOrgMember || !currentOrg) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Create Organization */}
        <form
          onSubmit={handleCreateOrg}
          className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4 h-fit"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#F4F5F7]">{t.createOrg}</h2>
            <Plus className="w-4 h-4 text-[#E04455]" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">{t.orgName}</label>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              minLength={3}
              maxLength={40}
              required
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">{t.orgTag}</label>
            <input
              type="text"
              value={orgTag}
              onChange={(e) => setOrgTag(e.target.value.toUpperCase())}
              minLength={2}
              maxLength={6}
              dir="ltr"
              required
              placeholder="NXR"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm font-mono-num text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">{t.orgDesc}</label>
            <textarea
              value={orgDesc}
              onChange={(e) => setOrgDesc(e.target.value)}
              maxLength={240}
              rows={3}
              className="w-full p-3 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <button
            type="submit"
            disabled={busyKey === 'create_org' || (wallet?.balance ?? 0) < ORG_CREATION_COST}
            className="w-full min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-sm font-semibold transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
          >
            {t.createOrg} ({ORG_CREATION_COST.toLocaleString()})
          </button>
        </form>

        {/* Browse Organizations */}
        <div className="lg:col-span-2 space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#F4F5F7]">
              {language === 'ar' ? 'المنظمات والتحالفات النشطة' : 'Active Syndicates & Organizations'}
            </h2>
            <Building2 className="w-4 h-4 text-[#9299A6]" />
          </div>

          {organizations.length === 0 ? (
            <div className="bg-[#141821] border border-white/8 rounded-2xl p-8 text-center">
              <p className="text-sm text-[#9299A6]">
                {language === 'ar'
                  ? 'لا توجد منظمات مؤسسة بعد. كن أول من يؤسس تحالفاً اقتصادياً!'
                  : 'No organizations founded yet. Establish the first economic syndicate!'}
              </p>
            </div>
          ) : (
              organizations.map((org) => {
                const isPending = myPendingOrgIds.has(org.id);
                return (
                  <div
                    key={org.id}
                    className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <h3 className="text-base font-bold text-[#F4F5F7]">
                        [{org.tag}] {org.name}
                      </h3>
                      <p className="text-xs text-[#9299A6]">
                        {org.leaderName} · {t.members}:{' '}
                        <span className="font-mono-num text-[#F4F5F7]">{org.memberCount}</span> ·{' '}
                        {t.reputation}:{' '}
                        <span className="font-mono-num text-[#F4F5F7]">{org.reputation}</span>
                      </p>
                      {org.description && (
                        <p className="text-xs text-[#9299A6]/90 pt-1">{org.description}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={isPending || busyKey === `join_${org.id}`}
                      onClick={() => handleRequestJoin(org.id)}
                      className="min-h-[42px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold whitespace-nowrap shrink-0 disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                    >
                      {isPending ? t.requestPending : busyKey === `join_${org.id}` ? '...' : t.joinOrg}
                    </button>
                  </div>
                );
              })
          )}
        </div>
      </div>
    );
  }

  const orgUpgradeCost = calculateOrgUpgradeCost(currentOrg.level);
  const isOrgMaxLevel = currentOrg.level >= ORG_MAX_LEVEL;

  return (
    <div className="space-y-5">
      {/* Organization Header */}
      <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-[#E04455]" />
            <h1 className="text-xl font-bold text-[#F4F5F7]">
              [{currentOrg.tag}] {currentOrg.name}
            </h1>
          </div>
          <p className="text-xs text-[#9299A6]">
            {t.level} <span className="font-mono-num text-[#F4F5F7]">{currentOrg.level}</span> ·{' '}
            {t.members}{' '}
            <span className="font-mono-num text-[#F4F5F7]">{currentOrg.memberCount}</span> ·{' '}
            {t.reputation}{' '}
            <span className="font-mono-num text-[#F4F5F7]">{currentOrg.reputation}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-end">
            <p className="text-xs text-[#9299A6]">{t.orgTreasury}</p>
            <p className="text-lg font-bold font-mono-num text-emerald-400">
              {currentOrg.treasuryBalance.toLocaleString()} {t.currency}
            </p>
          </div>
          {canManageOrg && (
            <button
              type="button"
              disabled={
                isOrgMaxLevel ||
                busyKey === 'upgrade_org' ||
                currentOrg.treasuryBalance < orgUpgradeCost
              }
              onClick={handleUpgradeOrg}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:bg-[#1B2230] disabled:text-[#9299A6]"
            >
              <ArrowUpCircle className="w-4 h-4" />
              <span>
                {isOrgMaxLevel
                  ? t.maxLevelReached
                  : `${t.upgradeOrg} (${orgUpgradeCost.toLocaleString()})`}
              </span>
            </button>
          )}
          {myOrgMember.role !== 'leader' && (
            <button
              type="button"
              onClick={() => setConfirmLeaveOpen(true)}
              className="min-h-[40px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#E04455] text-xs font-semibold whitespace-nowrap"
            >
              {t.leaveOrg}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Shared Treasury Operations & RBAC Matrix */}
        <div className="space-y-5">
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.orgTreasury}</h2>
              <Vault className="w-4 h-4 text-[#E04455]" />
            </div>

            <div className="flex items-center gap-2.5">
              <input
                type="number"
                min={1}
                value={treasuryAmt || ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setTreasuryAmt(v === '' ? 0 : sanitizePositiveInt(v, 1));
                }}
                onBlur={() => setTreasuryAmt((v) => sanitizePositiveInt(v, 1))}
                className="flex-1 min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm font-mono-num text-[#F4F5F7]"
              />
              <button
                type="button"
                disabled={busyKey === 'dep' || treasuryAmt < 1 || (wallet?.balance ?? 0) < treasuryAmt}
                onClick={handleDeposit}
                className="min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold whitespace-nowrap disabled:bg-[#1B2230] disabled:text-[#9299A6]"
              >
                {t.deposit}
              </button>
              {canManageTreasury && (
                <button
                  type="button"
                  disabled={busyKey === 'wdr' || treasuryAmt < 1 || currentOrg.treasuryBalance < treasuryAmt}
                  onClick={handleWithdraw}
                  className="min-h-[44px] px-4 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold whitespace-nowrap disabled:opacity-50"
                >
                  {t.withdraw}
                </button>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t border-white/8">
              {orgTransactions.length === 0 ? (
                <p className="text-xs text-[#9299A6] py-4 text-center">{t.noActivity}</p>
              ) : (
                orgTransactions.slice(0, 8).map((otx) => {
                  const isInflow = otx.type === 'deposit';
                  const typeLabel =
                    otx.type === 'upgrade'
                      ? t.upgradeOrg
                      : otx.type === 'deposit'
                      ? t.deposit
                      : t.withdraw;
                  return (
                    <div
                      key={otx.id}
                      className="flex items-center justify-between text-xs py-2 border-b border-white/6 last:border-0"
                    >
                      <span className="text-[#9299A6]">
                        {otx.username} · {typeLabel}
                      </span>
                      <span
                        className={`font-mono-num font-semibold ${
                          isInflow ? 'text-emerald-400' : 'text-[#E04455]'
                        }`}
                      >
                        {isInflow ? '+' : '-'}
                        {otx.amount.toLocaleString()}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Role Permissions Matrix */}
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#F4F5F7]">{t.orgPerks}</h2>
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              {(['leader', 'deputy', 'officer', 'member'] as const).map((role) => {
                const perms = ROLE_DEFAULT_PERMISSIONS[role];
                const isMine = myOrgMember.role === role;
                return (
                  <div
                    key={role}
                    className={`p-3 rounded-xl border ${
                      isMine ? 'bg-[#1B2230] border-[#E04455]/50' : 'bg-[#0B0D12] border-white/6'
                    }`}
                  >
                    <p className="font-semibold text-[#F4F5F7]">{formatOrgRole(role, language)}</p>
                    <p className="text-[11px] text-[#9299A6] mt-1 leading-relaxed">
                      {perms.length === 0
                        ? language === 'ar'
                          ? 'مساهمة الخزينة والاطلاع'
                          : 'Treasury deposits & view'
                        : perms
                            .map((p) =>
                              p === 'manage_members'
                                ? language === 'ar'
                                  ? 'الأعضاء'
                                  : 'Members'
                                : p === 'manage_roles'
                                ? language === 'ar'
                                  ? 'الرتب'
                                  : 'Roles'
                                : p === 'manage_treasury'
                                ? language === 'ar'
                                  ? 'السحب'
                                  : 'Treasury'
                                : language === 'ar'
                                ? 'الترقية'
                                : 'Upgrade'
                            )
                            .join(' · ')}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Members & RBAC + Join Requests */}
        <div className="space-y-5">
          {canManageMembers && orgRequests.length > 0 && (
            <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.joinRequests}</h2>
              <div className="space-y-2">
                {orgRequests.map((req) => (
                  <div
                    key={req.id}
                    className="p-3 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                  >
                    <span className="text-sm font-medium text-[#F4F5F7]">{req.username}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busyKey === `req_${req.id}`}
                        onClick={() => handleJoinDecision(req, 'approved')}
                        className="min-h-[38px] px-3 rounded-lg bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{t.approve}</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === `req_${req.id}`}
                        onClick={() => handleJoinDecision(req, 'rejected')}
                        className="min-h-[38px] px-3 rounded-lg bg-[#1B2230] hover:bg-[#232C3E] text-[#9299A6] text-xs font-semibold flex items-center gap-1 disabled:opacity-50"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>{t.reject}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.members}</h2>
              <Users className="w-4 h-4 text-[#9299A6]" />
            </div>
            <div className="space-y-2">
              {orgMembers.map((m) => {
                const contributed = contributionsByUid.get(m.uid) || 0;
                const canChangeRole =
                  canManageRoles &&
                  m.uid !== profile.uid &&
                  m.role !== 'leader' &&
                  (myOrgMember.role === 'leader' || m.role !== 'deputy');
                const canKick =
                  canManageMembers &&
                  m.uid !== profile.uid &&
                  canManageOrgMember(myOrgMember.role, m.role);

                return (
                  <div
                    key={m.uid}
                    className="p-3 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#F4F5F7] truncate">{m.username}</p>
                      <p className="text-xs text-[#9299A6] mt-0.5">
                        {formatOrgRole(m.role, language)}
                        {contributed > 0 && (
                          <span className="ms-2 font-mono-num text-emerald-400">
                            · +{contributed.toLocaleString()}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {canChangeRole && (
                        <select
                          value={m.role}
                          disabled={busyKey === `role_${m.uid}`}
                          onChange={(e) =>
                            handleRoleChange(m.uid, e.target.value as Exclude<OrgRole, 'leader'>)
                          }
                          className="min-h-[38px] px-2.5 rounded-lg bg-[#141821] border border-white/10 text-xs text-[#F4F5F7]"
                        >
                          <option value="member">{formatOrgRole('member', language)}</option>
                          <option value="officer">{formatOrgRole('officer', language)}</option>
                          {myOrgMember.role === 'leader' && (
                            <option value="deputy">{formatOrgRole('deputy', language)}</option>
                          )}
                        </select>
                      )}
                      {canKick && (
                        <button
                          type="button"
                          disabled={busyKey === `kick_${m.uid}`}
                          onClick={() => setKickTarget({ uid: m.uid, username: m.username })}
                          title={t.kick}
                          aria-label={t.kick}
                          className="min-h-[38px] px-2.5 rounded-lg bg-[#1B2230] hover:bg-[#B91C32]/30 text-[#E04455] text-xs font-semibold flex items-center gap-1"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmLeaveOpen}
        title={t.leaveOrg}
        description={
          language === 'ar'
            ? 'هل تريد مغادرة المنظمة الحالية؟ ستفقد رتبتك الحالية.'
            : 'Leave your current organization? You will lose your current rank.'
        }
        confirmLabel={t.confirmBtn}
        cancelLabel={t.cancelBtn}
        busy={busyKey === 'leave'}
        onConfirm={handleLeave}
        onCancel={() => setConfirmLeaveOpen(false)}
      />

      <ConfirmDialog
        open={kickTarget !== null}
        title={t.kick}
        description={
          kickTarget
            ? language === 'ar'
              ? `هل تريد إزالة العضو ${kickTarget.username} من المنظمة؟`
              : `Remove ${kickTarget.username} from the organization?`
            : ''
        }
        confirmLabel={t.confirmBtn}
        cancelLabel={t.cancelBtn}
        busy={kickTarget !== null && busyKey === `kick_${kickTarget.uid}`}
        onConfirm={handleConfirmKick}
        onCancel={() => setKickTarget(null)}
      />
    </div>
  );
}
