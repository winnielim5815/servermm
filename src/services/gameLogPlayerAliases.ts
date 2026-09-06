const addUsernameAliases = (aliases: Set<string>, value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!normalized) return;

  aliases.add(normalized);
  if (normalized.includes('.')) {
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length > 0) aliases.add(parts[parts.length - 1]);
  }
};

export const getGameLogPlayerAliases = (player: any, gameName: string): string[] => {
  const aliases = new Set<string>();
  addUsernameAliases(aliases, player?.player_game_id);

  const targetGameName = String(gameName || '').trim().toLowerCase();
  const gameAccounts = Array.isArray(player?.metadata?.gameAccounts)
    ? player.metadata.gameAccounts
    : [];

  for (const gameAccount of gameAccounts) {
    const accountGameName = String(gameAccount?.gameName || '').trim().toLowerCase();
    if (!targetGameName || accountGameName !== targetGameName) continue;
    addUsernameAliases(aliases, gameAccount?.accountId);
    addUsernameAliases(aliases, gameAccount?.displayAccountId);
  }

  return Array.from(aliases);
};
