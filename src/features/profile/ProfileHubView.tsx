import { Activity, Award, Globe, LogOut, ShieldCheck, Sliders, Trophy, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/ui/ToastProvider';
import { ACHIEVEMENTS, AVATARS, MISSIONS, SKILL_DEFINITIONS } from '../../data/catalog';
import { useTranslations } from '../../i18n/translations';
import {
  verifyDiagnosticsOwnerAccess,
  type ClientSnapshotContext,
} from '../../services/diagnosticsService';
import {
  claimMissionReward,
  fetchLeaderboards,
  updatePlayerAvatar,
  updatePlayerSettings,
  upgradeSkill,
} from '../../services/gameService';
import type {
  Company,
  Language,
  Organization,
  PlayerMissionClaim,
  PlayerProfile,
  ProfileSubTab,
  SkillKey,
  UserPrivate,
} from '../../types/game';
import { DiagnosticsView } from '../diagnostics/DiagnosticsView';

interface ProfileHubViewProps {
  profile: PlayerProfile;
  userPrivate: UserPrivate | null;
  claimedMissions: PlayerMissionClaim[];
  unlockedAchievements: Set<string>;
  diagnosticsContext: ClientSnapshotContext;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onLogout: () => Promise<void>;
}

export function ProfileHubView({
  profile,
  userPrivate,
  claimedMissions,
  unlockedAchievements,
  diagnosticsContext,
  language,
  onLanguageChange,
  onLogout,
}: ProfileHubViewProps) {
  const t = useTranslations(language);
  const { showToast } = useToast();

  const [subTab, setSubTab] = useState<ProfileSubTab>('overview');
  const [isOwnerAuthorized, setIsOwnerAuthorized] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [lbTab, setLbTab] = useState<'players' | 'companies' | 'orgs'>('players');
  const [leaderboards, setLeaderboards] = useState<{
    players: PlayerProfile[];
    companies: Company[];
    organizations: Organization[];
  }>({ players: [], companies: [], organizations: [] });
  const [lbLoading, setLbLoading] = useState(false);

  const claimedSet = new Set(claimedMissions.map((m) => m.missionId));
  const avatar = AVATARS.find((a) => a.id === profile.avatarId) || AVATARS[0];

  useEffect(() => {
    verifyDiagnosticsOwnerAccess()
      .then((res) => setIsOwnerAuthorized(res.authorized))
      .catch(() => setIsOwnerAuthorized(false));
  }, [profile.uid]);

  useEffect(() => {
    if (subTab !== 'rankings') return;
    setLbLoading(true);
    fetchLeaderboards()
      .then((res) => setLeaderboards(res))
      .catch(() => {})
      .finally(() => setLbLoading(false));
  }, [subTab]);

  async function handleUpgradeSkill(key: SkillKey) {
    setBusyKey(`sk_${key}`);
    try {
      await upgradeSkill(profile.uid, key);
      showToast(language === 'ar' ? 'تم تطوير المهارة بنجاح.' : 'Skill upgraded.', 'success');
    } catch {
      showToast(
        language === 'ar' ? 'لا توجد نقاط مهارة متاحة.' : 'No skill points available.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleClaimMission(missionId: string) {
    setBusyKey(`mis_${missionId}`);
    try {
      await claimMissionReward(profile.uid, missionId);
      showToast(language === 'ar' ? 'تم استلام المكافأة.' : 'Reward claimed.', 'success');
    } catch {
      showToast(
        language === 'ar' ? 'المهمة لم تكتمل بعد.' : 'Mission requirements not yet met.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleLanguageToggle(nextLang: Language) {
    onLanguageChange(nextLang);
    try {
      await updatePlayerSettings(
        profile.uid,
        nextLang,
        userPrivate?.notificationsEnabled ?? true
      );
    } catch {
      // Persisted locally as fallback
    }
  }

  async function handleNotifToggle() {
    const nextVal = !(userPrivate?.notificationsEnabled ?? true);
    try {
      await updatePlayerSettings(profile.uid, language, nextVal);
      showToast(
        language === 'ar' ? 'تم تحديث إعدادات الإشعارات.' : 'Notification preferences saved.',
        'success'
      );
    } catch {
      showToast(language === 'ar' ? 'تعذر الحفظ.' : 'Save failed.', 'error');
    }
  }

  const subTabs: { id: ProfileSubTab; label: string }[] = [
    { id: 'overview', label: t.subOverview },
    { id: 'skills', label: t.subSkills },
    { id: 'missions', label: t.subMissions },
    { id: 'rankings', label: t.subRankings },
    { id: 'settings', label: t.subSettings },
    ...(isOwnerAuthorized ? [{ id: 'diagnostics' as const, label: t.subDiagnostics }] : []),
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id)}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              subTab === tab.id
                ? 'bg-[#B91C32] text-white'
                : 'bg-[#141821] text-[#9299A6] border border-white/8 hover:text-[#F4F5F7]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 1. OVERVIEW */}
      {subTab === 'overview' && (
        <div className="space-y-5">
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <img
                src={avatar.src}
                alt={profile.username}
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-2xl object-cover border border-white/10"
              />
              <div>
                <h1 className="text-lg font-bold text-[#F4F5F7]">{profile.username}</h1>
                <p className="text-xs text-[#9299A6] mt-0.5">
                  {profile.title} · {t.level} {profile.level} · {profile.xp.toLocaleString()} XP
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {AVATARS.map((av) => (
                <button
                  key={av.id}
                  type="button"
                  onClick={() => updatePlayerAvatar(profile.uid, av.id)}
                  className={`w-10 h-10 rounded-xl overflow-hidden border transition-colors ${
                    profile.avatarId === av.id ? 'border-[#E04455]' : 'border-white/10 opacity-70 hover:opacity-100'
                  }`}
                >
                  <img
                    src={av.src}
                    alt={language === 'ar' ? av.labelAr : av.labelEn}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: language === 'ar' ? 'الصفقات' : 'Trades', val: profile.stats.tradesCount },
              { label: language === 'ar' ? 'الإنتاج' : 'Produced', val: profile.stats.totalProduced },
              { label: t.subCompanies, val: profile.stats.companiesOwned },
              { label: t.subProperties, val: profile.stats.propertiesOwned },
              { label: t.subMissions, val: profile.stats.missionsCompleted },
            ].map((s) => (
              <div key={s.label} className="bg-[#141821] border border-white/8 rounded-2xl p-4">
                <p className="text-xs text-[#9299A6]">{s.label}</p>
                <p className="text-lg font-bold font-mono-num text-[#F4F5F7] mt-1">{s.val}</p>
              </div>
            ))}
          </div>

          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.achievementsTitle}</h2>
              <Trophy className="w-4 h-4 text-[#E04455]" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ACHIEVEMENTS.map((ach) => {
                const unlocked = unlockedAchievements.has(ach.id);
                return (
                  <div
                    key={ach.id}
                    className={`p-3.5 rounded-xl border ${
                      unlocked
                        ? 'bg-[#1B2230] border-[#B91C32]/40'
                        : 'bg-[#0B0D12] border-white/6 opacity-65'
                    }`}
                  >
                    <p className="text-sm font-semibold text-[#F4F5F7]">
                      {language === 'ar' ? ach.titleAr : ach.titleEn}
                    </p>
                    <p className="text-xs text-[#9299A6] mt-0.5">
                      {language === 'ar' ? ach.descriptionAr : ach.descriptionEn}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 2. SKILLS TREE */}
      {subTab === 'skills' && (
        <div className="space-y-4">
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-4 flex items-center justify-between">
            <span className="text-sm font-medium text-[#F4F5F7]">{t.skillPoints}</span>
            <span className="text-lg font-bold font-mono-num text-[#E04455]">
              {profile.skillPoints}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {SKILL_DEFINITIONS.map((sk) => {
              const cur = profile.skills[sk.key] || 0;
              const maxed = cur >= sk.maxLevel;
              return (
                <div
                  key={sk.key}
                  className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-bold text-[#F4F5F7]">
                        {language === 'ar' ? sk.nameAr : sk.nameEn}
                      </h3>
                      <span className="font-mono-num text-sm font-semibold text-[#E04455]">
                        {cur} / {sk.maxLevel}
                      </span>
                    </div>
                    <p className="text-xs text-[#9299A6] mt-1.5 leading-relaxed">
                      {language === 'ar' ? sk.effectAr : sk.effectEn}
                    </p>
                  </div>

                  <div className="h-1.5 rounded-full bg-[#0B0D12] overflow-hidden">
                    <div
                      className="h-full bg-[#B91C32] rounded-full"
                      style={{ width: `${(cur / sk.maxLevel) * 100}%` }}
                    />
                  </div>

                  <button
                    type="button"
                    disabled={maxed || profile.skillPoints < 1 || busyKey === `sk_${sk.key}`}
                    onClick={() => handleUpgradeSkill(sk.key)}
                    className="w-full min-h-[42px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>{maxed ? 'MAX' : t.upgradeSkill}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. MISSIONS */}
      {subTab === 'missions' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {MISSIONS.map((m) => {
            const isClaimed = claimedSet.has(m.id);
            const val =
              m.metric === 'trades'
                ? profile.stats.tradesCount
                : m.metric === 'companies'
                ? profile.stats.companiesOwned
                : m.metric === 'properties'
                ? profile.stats.propertiesOwned
                : m.metric === 'produced'
                ? profile.stats.totalProduced
                : m.metric === 'org'
                ? profile.orgId
                  ? 1
                  : 0
                : profile.level;
            const ready = val >= m.targetCount && !isClaimed;

            return (
              <div
                key={m.id}
                className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-[#F4F5F7]">
                      {language === 'ar' ? m.titleAr : m.titleEn}
                    </h3>
                    <Award className="w-4 h-4 text-[#E04455] shrink-0" />
                  </div>
                  <p className="text-xs text-[#9299A6]">
                    {m.category} · <span className="font-mono-num">{Math.min(val, m.targetCount)}/{m.targetCount}</span>
                  </p>
                  <p className="text-xs text-[#9299A6] pt-1 leading-relaxed">
                    {language === 'ar' ? m.descriptionAr : m.descriptionEn}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/6">
                  <span className="text-xs font-mono-num text-[#F4F5F7]">
                    +{m.rewardCredits} {t.currency} · +{m.rewardXp} XP
                  </span>
                  <button
                    type="button"
                    disabled={!ready || busyKey === `mis_${m.id}`}
                    onClick={() => handleClaimMission(m.id)}
                    className="min-h-[40px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                  >
                    {isClaimed ? t.claimed : ready ? t.claimReward : t.inProgress}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 4. RANKINGS */}
      {subTab === 'rankings' && (
        <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-1.5">
            {[
              { id: 'players' as const, label: t.leaderboardWealth },
              { id: 'companies' as const, label: t.leaderboardCompanies },
              { id: 'orgs' as const, label: t.leaderboardOrgs },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLbTab(item.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors ${
                  lbTab === item.id
                    ? 'bg-[#B91C32] text-white'
                    : 'bg-[#0B0D12] text-[#9299A6] hover:text-[#F4F5F7]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {lbLoading ? (
            <p className="text-sm text-[#9299A6] py-8 text-center">{t.loading}</p>
          ) : lbTab === 'players' ? (
            <div className="space-y-2">
              {leaderboards.players.map((p, idx) => (
                <div
                  key={p.uid}
                  className="p-3.5 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 text-center font-mono-num text-xs font-bold text-[#E04455]">
                      #{idx + 1}
                    </span>
                    <span className="text-sm font-medium text-[#F4F5F7] truncate">
                      {p.username}
                    </span>
                  </div>
                  <span className="text-xs font-mono-num text-[#9299A6]">
                    Lv.{p.level} · {p.influence} {t.influence}
                  </span>
                </div>
              ))}
            </div>
          ) : lbTab === 'companies' ? (
            <div className="space-y-2">
              {leaderboards.companies.map((c, idx) => (
                <div
                  key={c.id}
                  className="p-3.5 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 text-center font-mono-num text-xs font-bold text-[#E04455]">
                      #{idx + 1}
                    </span>
                    <span className="text-sm font-medium text-[#F4F5F7] truncate">{c.name}</span>
                  </div>
                  <span className="text-xs font-mono-num text-emerald-400">
                    {c.totalRevenue.toLocaleString()} {t.currency}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {leaderboards.organizations.map((o, idx) => (
                <div
                  key={o.id}
                  className="p-3.5 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-6 text-center font-mono-num text-xs font-bold text-[#E04455]">
                      #{idx + 1}
                    </span>
                    <span className="text-sm font-medium text-[#F4F5F7] truncate">
                      [{o.tag}] {o.name}
                    </span>
                  </div>
                  <span className="text-xs font-mono-num text-[#F4F5F7]">
                    {o.reputation} {t.reputation}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5. SETTINGS */}
      {subTab === 'settings' && (
        <div className="max-w-lg bg-[#141821] border border-white/8 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#F4F5F7]">{t.subSettings}</h2>
            <Sliders className="w-4 h-4 text-[#9299A6]" />
          </div>

          <div className="flex items-center justify-between py-2 border-b border-white/8">
            <div className="flex items-center gap-2.5">
              <Globe className="w-4 h-4 text-[#E04455]" />
              <span className="text-sm text-[#F4F5F7]">{t.languageSetting}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleLanguageToggle('ar')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  language === 'ar'
                    ? 'bg-[#B91C32] text-white'
                    : 'bg-[#0B0D12] text-[#9299A6]'
                }`}
              >
                العربية
              </button>
              <button
                type="button"
                onClick={() => handleLanguageToggle('en')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  language === 'en'
                    ? 'bg-[#B91C32] text-white'
                    : 'bg-[#0B0D12] text-[#9299A6]'
                }`}
              >
                English
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between py-2 border-b border-white/8">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-[#E04455]" />
              <span className="text-sm text-[#F4F5F7]">{t.notificationsSetting}</span>
            </div>
            <button
              type="button"
              onClick={handleNotifToggle}
              className={`min-h-[36px] px-4 rounded-lg text-xs font-semibold ${
                userPrivate?.notificationsEnabled ?? true
                  ? 'bg-[#B91C32] text-white'
                  : 'bg-[#0B0D12] text-[#9299A6]'
              }`}
            >
              {(userPrivate?.notificationsEnabled ?? true)
                ? language === 'ar'
                  ? 'مفعل'
                  : 'Enabled'
                : language === 'ar'
                ? 'معطل'
                : 'Muted'}
            </button>
          </div>

          <div className="pt-2 border-t border-white/8 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Activity className="w-4 h-4 text-[#E04455]" />
              <span className="text-sm text-[#F4F5F7]">{t.subDiagnostics}</span>
            </div>
            <button
              type="button"
              onClick={() => setSubTab('diagnostics')}
              className="min-h-[40px] px-4 rounded-xl bg-[#0B0D12] border border-white/8 hover:border-[#B91C32]/50 text-xs font-semibold text-[#F4F5F7] whitespace-nowrap shrink-0 transition-colors"
            >
              {t.diagTitle}
            </button>
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="w-full min-h-[44px] px-4 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#E04455] text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>{t.signOut}</span>
          </button>
        </div>
      )}

      {/* 6. DIAGNOSTICS (Owner-Gated) */}
      {subTab === 'diagnostics' && (
        <DiagnosticsView language={language} snapshotContext={diagnosticsContext} />
      )}
    </div>
  );
}
