import { getGameLogPlayerAliases } from './gameLogPlayerAliases';

describe('game log player aliases', () => {
  it('maps the platform ID plus full and unqualified Joker usernames', () => {
    expect(getGameLogPlayerAliases({
      player_game_id: 'ABCDE123456',
      metadata: {
        gameAccounts: [{
          gameName: 'Joker',
          accountId: 'APPID.AB1234567890',
          displayAccountId: 'AB1234567890',
        }],
      },
    }, 'joker')).toEqual([
      'ABCDE123456',
      'APPID.AB1234567890',
      'AB1234567890',
    ]);
  });

  it('does not use another game account as an alias', () => {
    expect(getGameLogPlayerAliases({
      player_game_id: 'ABCDE123456',
      metadata: {
        gameAccounts: [{ gameName: 'Other', accountId: 'OTHER.USER' }],
      },
    }, 'Joker')).toEqual(['ABCDE123456']);
  });
});
