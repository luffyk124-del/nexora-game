import type { Organization } from '../types/game';

export type OrganizationSort = 'reputation' | 'members' | 'level' | 'treasury';

export function searchAndSortOrganizations(organizations: Organization[], query: string, sortBy: OrganizationSort = 'reputation'): Organization[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return organizations.filter((organization) => {
    if (!normalizedQuery) return true;
    return [organization.name, organization.tag, organization.leaderName, organization.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }).sort((a, b) => {
    const difference = b[sortBy] - a[sortBy];
    return difference !== 0 ? difference : a.name.localeCompare(b.name);
  });
}
