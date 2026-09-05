export type NormalizedVendorGameLog = {
  player: string;
  vendorTransactionId: string;
  transactionOCode: string | null;
  roundId: string | null;
  gameCode: string | null;
  vendorCategory: string;
  gameName: string | null;
  gameCategory: string | null;
  description: string | null;
  transactionType: string | null;
  currencyCode: string | null;
  appId: string | null;
  isSpecial: boolean;
  amount: number;
  freeAmount: number;
  resultAmount: number;
  startBalance: number;
  endBalance: number;
  occurredAt: Date;
  rawDetails: string | null;
  rawPayload: any;
};

const finiteNumber = (value: any): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const textOrNull = (value: any): string | null => {
  if (value == null) return null;
  const valueAsText = typeof value === 'string' ? value : JSON.stringify(value);
  const trimmed = valueAsText.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizeVendorGameLogPage = (response: any): NormalizedVendorGameLog[] => {
  const gameInfo = new Map<string, { name: string | null; category: string | null }>();
  const games = Array.isArray(response?.games) ? response.games : [];
  for (const game of games) {
    const code = textOrNull(game?.GameCode);
    if (!code) continue;
    gameInfo.set(code, {
      name: textOrNull(game?.GameName),
      category: textOrNull(game?.GameType),
    });
  }

  const output: NormalizedVendorGameLog[] = [];
  const data = response?.data && typeof response.data === 'object' ? response.data : {};
  for (const [vendorCategory, rawItems] of Object.entries(data)) {
    if (!Array.isArray(rawItems)) continue;
    for (const item of rawItems) {
      const player = textOrNull((item as any)?.Username);
      const vendorTransactionId = textOrNull((item as any)?.OCode);
      const occurredAt = new Date(String((item as any)?.Time ?? ''));
      if (!player || !vendorTransactionId || Number.isNaN(occurredAt.getTime())) continue;

      const gameCode = textOrNull((item as any)?.GameCode);
      const info = gameCode ? gameInfo.get(gameCode) : undefined;
      output.push({
        player,
        vendorTransactionId,
        transactionOCode: textOrNull((item as any)?.TransactionOCode),
        roundId: textOrNull((item as any)?.RoundID),
        gameCode,
        vendorCategory,
        gameName: info?.name ?? null,
        gameCategory: info?.category ?? null,
        description: textOrNull((item as any)?.Description),
        transactionType: textOrNull((item as any)?.Type),
        currencyCode: textOrNull((item as any)?.CurrencyCode),
        appId: textOrNull((item as any)?.AppID),
        isSpecial: Boolean((item as any)?.IsSpecial),
        amount: finiteNumber((item as any)?.Amount),
        freeAmount: finiteNumber((item as any)?.FreeAmount),
        resultAmount: finiteNumber((item as any)?.Result),
        startBalance: finiteNumber((item as any)?.StartBalance),
        endBalance: finiteNumber((item as any)?.EndBalance),
        occurredAt,
        rawDetails: textOrNull((item as any)?.Details),
        rawPayload: item,
      });
    }
  }

  return output;
};
