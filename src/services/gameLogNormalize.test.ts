import { normalizeVendorGameLogPage } from './gameLogNormalize';

describe('normalizeVendorGameLogPage', () => {
  it('normalizes game metadata, amounts and local detail payloads', () => {
    const rows = normalizeVendorGameLogPage({
      games: [{ GameCode: 'slot-1', GameName: 'Lucky Slot', GameType: 'Slot' }],
      data: {
        Game: [
          {
            OCode: 'OC-1',
            TransactionOCode: 'TX-1',
            Username: 'PLAYER01',
            GameCode: 'slot-1',
            Description: 'spin',
            RoundID: 'ROUND-1',
            Amount: '12.50',
            FreeAmount: '1.25',
            Result: '20.00',
            Time: '2026-09-04T12:30:45.123+08:00',
            Details: { reels: [1, 2, 3] },
            AppID: 'APP-1',
            CurrencyCode: 'MYR',
            Type: 'Game',
            StartBalance: '100.00',
            EndBalance: '107.50',
          },
        ],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      player: 'PLAYER01',
      vendorTransactionId: 'OC-1',
      transactionOCode: 'TX-1',
      roundId: 'ROUND-1',
      gameCode: 'slot-1',
      vendorCategory: 'Game',
      gameName: 'Lucky Slot',
      gameCategory: 'Slot',
      amount: 12.5,
      freeAmount: 1.25,
      resultAmount: 20,
      startBalance: 100,
      endBalance: 107.5,
      rawDetails: '{"reels":[1,2,3]}',
    });
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-09-04T04:30:45.123Z');
  });

  it('supports jackpot and competition sections and skips unusable records', () => {
    const rows = normalizeVendorGameLogPage({
      data: {
        Jackpot: [{ OCode: 'JP-1', Username: 'P1', Time: '2026-09-04T01:00:00Z', Result: 8 }],
        Competition: [{ OCode: 'CP-1', Username: 'P2', Time: '2026-09-04T02:00:00Z', Amount: 2 }],
        Game: [
          { OCode: '', Username: 'P3', Time: '2026-09-04T03:00:00Z' },
          { OCode: 'BAD-TIME', Username: 'P4', Time: 'not-a-date' },
        ],
      },
    });

    expect(rows.map((row) => row.vendorCategory)).toEqual(['Jackpot', 'Competition']);
    expect(rows.map((row) => row.vendorTransactionId)).toEqual(['JP-1', 'CP-1']);
  });
});
