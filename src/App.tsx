/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AppShell } from './components/ui/AppShell';
import { ToastProvider } from './components/ui/ToastProvider';
import { AuthOnboardingView } from './features/auth/AuthOnboardingView';
import { BusinessHubView } from './features/business/BusinessHubView';
import { HomeDashboardView } from './features/home/HomeDashboardView';
import { MarketHubView } from './features/market/MarketHubView';
import { OrganizationHubView } from './features/organization/OrganizationHubView';
import { ProfileHubView } from './features/profile/ProfileHubView';
import { useGameData } from './hooks/useGameData';
import type { MainTab } from './types/game';

function NexoraAppContent() {
  const game = useGameData();
  const [activeTab, setActiveTab] = useState<MainTab>('home');

  if (!game.authReady || (game.authUser && game.profileLoading)) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <div className="h-12 rounded-2xl bg-[#141821] animate-pulse" />
          <div className="h-36 rounded-2xl bg-[#141821] animate-pulse" />
          <div className="h-24 rounded-2xl bg-[#141821] animate-pulse" />
        </div>
      </div>
    );
  }

  if (!game.authUser) {
    return (
      <AuthOnboardingView
        mode="signin"
        language={game.language}
        onLanguageChange={game.setLanguageLocal}
        onLogin={game.loginWithGoogle}
      />
    );
  }

  if (!game.profile) {
    return (
      <AuthOnboardingView
        mode="onboarding"
        uid={game.authUser.uid}
        email={game.authUser.email || ''}
        language={game.language}
        onLanguageChange={game.setLanguageLocal}
        onLogin={game.loginWithGoogle}
      />
    );
  }

  return (
    <AppShell
      activeTab={activeTab}
      onTabChange={setActiveTab}
      profile={game.profile}
      wallet={game.wallet}
      notifications={game.notifications}
      language={game.language}
    >
      {activeTab === 'home' && (
        <HomeDashboardView
          profile={game.profile}
          wallet={game.wallet}
          transactions={game.transactions}
          claimedMissions={game.claimedMissions}
          claimedDailyToday={game.claimedDailyToday}
          worldEvents={game.worldEvents}
          marketListings={game.marketListings}
          language={game.language}
          onNavigate={setActiveTab}
        />
      )}

      {activeTab === 'business' && (
        <BusinessHubView
          profile={game.profile}
          wallet={game.wallet}
          companies={game.companies}
          companyLogs={game.companyLogs}
          properties={game.properties}
          inventory={game.inventory}
          language={game.language}
          onGoToMarket={() => setActiveTab('market')}
        />
      )}

      {activeTab === 'market' && (
        <MarketHubView
          profile={game.profile}
          wallet={game.wallet}
          inventory={game.inventory}
          marketListings={game.marketListings}
          transactions={game.transactions}
          worldEvents={game.worldEvents}
          claimedContractsToday={game.claimedContractsToday}
          language={game.language}
        />
      )}

      {activeTab === 'organization' && (
        <OrganizationHubView
          profile={game.profile}
          wallet={game.wallet}
          organizations={game.organizations}
          myOrgMember={game.myOrgMember}
          orgMembers={game.orgMembers}
          orgRequests={game.orgRequests}
          orgTransactions={game.orgTransactions}
          language={game.language}
        />
      )}

      {activeTab === 'profile' && (
        <ProfileHubView
          profile={game.profile}
          userPrivate={game.userPrivate}
          claimedMissions={game.claimedMissions}
          unlockedAchievements={game.unlockedAchievements}
          diagnosticsContext={{
            profile: game.profile,
            wallet: game.wallet,
            myOrgMember: game.myOrgMember,
            companiesCount: game.companies.length,
            propertiesCount: game.properties.length,
            inventoryCount: game.inventory.length,
            claimedMissionsCount: game.claimedMissions.length,
            unlockedAchievementsCount: game.unlockedAchievements.size,
            locale: game.language,
          }}
          language={game.language}
          onLanguageChange={game.setLanguageLocal}
          onLogout={game.logout}
        />
      )}
    </AppShell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <NexoraAppContent />
    </ToastProvider>
  );
}
