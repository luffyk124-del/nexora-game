import { Globe, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AVATARS, BRAND_ASSETS, STARTING_CREDITS } from '../../data/catalog';
import { useTranslations } from '../../i18n/translations';
import { isValidUsername } from '../../lib/economy';
import { createPlayerCharacter, isUsernameAvailable } from '../../services/gameService';
import type { Language } from '../../types/game';
import { useToast } from '../../components/ui/ToastProvider';

interface AuthOnboardingViewProps {
  mode: 'signin' | 'onboarding';
  uid?: string;
  email?: string;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onLogin: () => Promise<void>;
}

export function AuthOnboardingView({
  mode,
  uid,
  email,
  language,
  onLanguageChange,
  onLogin,
}: AuthOnboardingViewProps) {
  const t = useTranslations(language);
  const { showToast } = useToast();

  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [avatarId, setAvatarId] = useState(AVATARS[0].id);

  async function handleGoogleLogin() {
    setBusy(true);
    try {
      await onLogin();
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
      let msg: string;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        msg =
          language === 'ar'
            ? 'تم إغلاق نافذة تسجيل الدخول قبل الإتمام.'
            : 'Sign-in pop-up was closed before completion.';
      } else if (code === 'auth/popup-blocked') {
        msg =
          language === 'ar'
            ? 'حظر المتصفح النافذة المنبثقة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.'
            : 'Sign-in pop-up was blocked by your browser. Allow pop-ups and retry.';
      } else if (code === 'auth/network-request-failed') {
        msg =
          language === 'ar'
            ? 'تعذر الاتصال بالشبكة. تحقق من اتصالك بالإنترنت.'
            : 'Network error. Check your internet connection and retry.';
      } else if (code === 'auth/unauthorized-domain') {
        msg =
          language === 'ar'
            ? 'نطاق اللعبة غير مضاف إلى النطاقات المسموح بها في Firebase Authentication.'
            : 'This game domain is not authorized in Firebase Authentication.';
      } else if (code === 'auth/operation-not-allowed') {
        msg =
          language === 'ar'
            ? 'تسجيل الدخول عبر Google غير مفعّل في إعدادات Firebase.'
            : 'Google sign-in is not enabled in Firebase Authentication.';
      } else {
        msg =
          language === 'ar'
            ? 'تعذر تسجيل الدخول عبر Google. حاول مرة أخرى.'
            : 'Google sign-in failed. Please try again.';
      }
      showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateCharacter(e: React.FormEvent) {
    e.preventDefault();
    if (!uid || !email) return;

    const clean = username.trim();
    if (!isValidUsername(clean)) {
      showToast(
        language === 'ar'
          ? 'اسم المستخدم يجب أن يكون بين 3 و24 حرفاً إنجليزياً أو رقماً أو _.'
          : 'Username must be 3–24 letters, numbers, or underscores.',
        'error'
      );
      return;
    }

    setBusy(true);
    try {
      const available = await isUsernameAvailable(clean);
      if (!available) {
        showToast(
          language === 'ar' ? 'اسم المستخدم محجوز بالفعل.' : 'Username is already taken.',
          'error'
        );
        setBusy(false);
        return;
      }

      await createPlayerCharacter(uid, email, clean, avatarId, language);
      showToast(
        language === 'ar'
          ? 'تم إنشاء شخصيتك وإيداع رأس المال بنجاح.'
          : 'Character created and starting capital credited.',
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'USERNAME_TAKEN'
          ? language === 'ar'
            ? 'اسم المستخدم محجوز بالفعل.'
            : 'Username already taken.'
          : language === 'ar'
          ? 'تعذر إنشاء الشخصية، حاول مرة أخرى.'
          : 'Could not create profile. Please retry.',
        'error'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#F4F5F7] flex flex-col justify-between px-4 py-6 sm:px-6">
      {/* Minimal Top Bar */}
      <div className="max-w-4xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img
            src={BRAND_ASSETS.emblem}
            alt="NEXORA"
            referrerPolicy="no-referrer"
            className="w-8 h-8 rounded-lg object-cover border border-white/10"
          />
          <span className="text-lg font-bold tracking-tight">NEXORA</span>
        </div>

        <button
          type="button"
          onClick={() => onLanguageChange(language === 'ar' ? 'en' : 'ar')}
          className="min-h-[40px] px-3.5 rounded-xl bg-[#141821] border border-white/10 text-xs font-medium text-[#F4F5F7] flex items-center gap-2 hover:bg-[#1B2230] transition-colors"
        >
          <Globe className="w-4 h-4 text-[#E04455]" />
          <span>{language === 'ar' ? 'English' : 'العربية'}</span>
        </button>
      </div>

      {/* Main Auth / Onboarding Card */}
      <div className="max-w-md w-full mx-auto my-auto py-8">
        {mode === 'signin' ? (
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
            <div className="flex flex-col items-center text-center space-y-4">
              <img
                src={BRAND_ASSETS.emblem}
                alt="NEXORA Emblem"
                referrerPolicy="no-referrer"
                className="w-20 h-20 rounded-2xl object-cover border border-white/10"
              />
              <div className="space-y-2">
                <h1 className="text-2xl font-bold text-[#F4F5F7] text-balance">
                  {t.signInTitle}
                </h1>
                <p className="text-sm text-[#9299A6] leading-relaxed">{t.signInSubtitle}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 pt-2 border-t border-white/8 text-center text-xs">
              <div>
                <p className="text-[#9299A6]">{language === 'ar' ? 'رأس المال' : 'Capital'}</p>
                <p className="font-mono-num text-[#F4F5F7] font-semibold mt-0.5">
                  {'$'}{STARTING_CREDITS.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-[#9299A6]">{language === 'ar' ? 'القطاعات' : 'Sectors'}</p>
                <p className="font-mono-num text-[#F4F5F7] font-semibold mt-0.5">5</p>
              </div>
              <div>
                <p className="text-[#9299A6]">{language === 'ar' ? 'المهارات' : 'Skills'}</p>
                <p className="font-mono-num text-[#F4F5F7] font-semibold mt-0.5">6</p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={busy}
              className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2.5 disabled:opacity-60"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{busy ? t.signingIn : t.signInButton}</span>
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleCreateCharacter}
            className="bg-[#141821] border border-white/8 rounded-2xl p-6 sm:p-7 shadow-2xl space-y-5"
          >
            <div className="space-y-1.5">
              <h1 className="text-xl font-bold text-[#F4F5F7]">{t.onboardingTitle}</h1>
              <p className="text-sm text-[#9299A6]">{t.onboardingSubtitle}</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="nexora-username" className="block text-sm font-medium text-[#F4F5F7]">
                {t.usernameLabel}
              </label>
              <input
                id="nexora-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t.usernamePlaceholder}
                dir="ltr"
                maxLength={24}
                required
                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#0B0D12] border border-white/10 text-[#F4F5F7] placeholder:text-[#9299A6]/60 focus:outline-none focus:border-[#E04455] text-sm"
              />
              <p className="text-xs text-[#9299A6]">{t.usernameHint}</p>
            </div>

            <div className="space-y-2.5">
              <p className="text-sm font-medium text-[#F4F5F7]">{t.chooseAvatar}</p>
              <div className="grid grid-cols-3 gap-3">
                {AVATARS.map((av) => {
                  const selected = avatarId === av.id;
                  return (
                    <button
                      key={av.id}
                      type="button"
                      onClick={() => setAvatarId(av.id)}
                      className={`p-2 rounded-xl border text-center transition-colors ${
                        selected
                          ? 'bg-[#1B2230] border-[#E04455]'
                          : 'bg-[#0B0D12] border-white/8 hover:border-white/20'
                      }`}
                    >
                      <img
                        src={av.src}
                        alt={language === 'ar' ? av.labelAr : av.labelEn}
                        referrerPolicy="no-referrer"
                        className="w-full aspect-square rounded-lg object-cover mb-2"
                      />
                      <span className="block text-[11px] font-medium text-[#F4F5F7] truncate">
                        {language === 'ar' ? av.labelAr : av.labelEn}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white font-semibold text-sm transition-colors disabled:opacity-60"
            >
              {busy ? t.loading : t.createCharacterBtn}
            </button>
          </form>
        )}
      </div>

      <footer className="max-w-4xl w-full mx-auto text-center text-xs text-[#9299A6]">
        NEXORA · {t.tagline}
      </footer>
    </div>
  );
}
