import crypto from 'crypto';

/**
 * Joker Document Transfer Wallet API Provider
 * Implements all API methods from v3.0.1 documentation
 */
export interface JokerConfig {
  apiUrl: string;
  appId: string;
  signatureKey: string;
}

export interface JokerResponse {
  success: boolean;
  data?: any;
  error?: string;
  httpStatus?: number;
  durationMs?: number;
  message?: string;
  rawText?: string;
}

export interface CreatePlayerResponse {
  Status: 'OK' | 'Created';
}

export interface GetCreditResponse {
  Username: string;
  Credit: number;
  OutstandingCredit: number;
  FreeCredit: number;
  OutstandingFreeCredit: number;
}

export interface TransferCreditResponse {
  Username: string;
  RequestID: string;
  Credit: number;
  BeforeCredit: number;
  OutstandingCredit: number;
  FreeCredit: number;
  OutstandingFreeCredit: number;
  Time: string;
}

export interface VerifyTransferResponse {
  Username: string;
  RequestID: string;
  Amount: number;
  Time: string;
}

export interface WithdrawAllResponse {
  Username: string;
  RequestID: string;
  Amount: number;
  Time: string;
}

export interface GameInfo {
  GameCode: string;
  GameName: string;
  GameType: string;
}

export interface GetGameListResponse {
  games: GameInfo[];
}

export interface LaunchGameResponse {
  Url: string;
}

export interface TransactionItem {
  OCode: string;
  Username: string;
  GameCode: string;
  Description: string;
  RoundID: string;
  IsSpecial: boolean;
  Amount: number;
  FreeAmount: number;
  Result: number;
  Time: string;
  Details: string | null;
  AppID: string;
  CurrencyCode: string;
  Type: string;
  TransactionOCode: string;
  StartBalance: number;
  EndBalance: number;
  ExternalInfo?: string;
}

export interface GetTransactionsResponse {
  data: {
    Game?: TransactionItem[];
    Jackpot?: TransactionItem[];
    Competition?: TransactionItem[];
  };
  nextId: string;
  games: GameInfo[];
}

export interface WinlossItem {
  Username: string;
  Amount: number;
  Result: number;
}

export interface GetWinlossResponse {
  Winloss: WinlossItem[];
}

export interface GetHistoryUrlResponse {
  Url: string;
}

export interface SetPlayerStatusResponse {
  Status: 'OK';
}

export interface SetPlayerPasswordResponse {
  Status: 'OK';
}

export interface LogoutPlayerResponse {
  Status: 'OK';
}

export class JokerProvider {
  private config: JokerConfig;

  constructor(config: JokerConfig) {
    this.config = config;
  }

  private normalizeHistoryUrl(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return s;
    if (s.startsWith('http://') || s.startsWith('https://')) return s;

    const origin = new URL(this.config.apiUrl).origin;

    if (s.startsWith('//')) {
      const after = s.slice(2);
      const beforeSlashOrQ = after.split('/')[0].split('?')[0];
      const looksLikeHost = beforeSlashOrQ.includes('.') || beforeSlashOrQ.includes(':') || beforeSlashOrQ === 'localhost';
      if (looksLikeHost) return `https:${s}`;
      const asPath = `/${after}`;
      return new URL(asPath, origin).toString();
    }

    if (s.startsWith('/')) return new URL(s, origin).toString();
    return new URL(`/${s}`, origin).toString();
  }

  /**
   * Generate HMAC-SHA1 signature
   * Spec (v3.0.1):
   * 1) Take all JSON body fields (case-sensitive names)
   * 2) Sort field names A–Z
   * 3) Build raw string like: key1=value1&key2=value2&key3=value3&key4=
   * 4) HMAC-SHA1(rawString, SignatureKey) -> Base64
   * 5) URL-escape Base64 when sending as query param (URLSearchParams handles this)
   */
  private generateSignature(payload: Record<string, any>): string {
    const keys = Object.keys(payload)
      .filter((k) => payload[k] !== undefined)
      .sort();

    const raw = keys
      .map((k) => {
        const v = (payload as any)[k];
        return `${k}=${v === null ? '' : String(v)}`;
      })
      .join('&');

    const hmac = crypto.createHmac('sha1', this.config.signatureKey);
    hmac.update(raw, 'utf8');
    return hmac.digest('base64');
  }

  /**
   * Make HTTP request to Joker API
   */
  private async request(method: string, body: any, timeoutMs?: number): Promise<JokerResponse> {
    const startedAt = Date.now();
    const timestamp = Math.floor(Date.now() / 1000);

    const requestBody = {
      Method: method,
      Timestamp: timestamp,
      ...body,
    };

    const signature = this.generateSignature(requestBody as any);

    const url = new URL(this.config.apiUrl);
    url.searchParams.append('appid', this.config.appId);
    url.searchParams.append('signature', signature);

    const controller = timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller?.signal,
      });

      const durationMs = Date.now() - startedAt;
      const httpStatus = response.status;
      const rawText = await response.text();
      const contentType = response.headers.get('content-type') || '';
      let parsed: any = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }

      const message =
        (parsed && typeof parsed === 'object' && typeof parsed.Message === 'string' && parsed.Message.trim().length > 0
          ? parsed.Message.trim()
          : parsed && typeof parsed === 'object' && typeof parsed.message === 'string' && parsed.message.trim().length > 0
            ? parsed.message.trim()
            : '');

      if (!response.ok) {
        if (response.status === 404) {
          return {
            success: false,
            error: message || 'Request not found',
            data: parsed,
            httpStatus,
            durationMs,
            message: message || undefined,
            rawText:
              !message && rawText && !contentType.includes('application/json') ? rawText.slice(0, 8000) : undefined,
          };
        }
        return {
          success: false,
          error: message || `HTTP error: ${response.status}`,
          data: parsed,
          httpStatus,
          durationMs,
          message: message || undefined,
          rawText:
            !message && rawText && !contentType.includes('application/json') ? rawText.slice(0, 8000) : undefined,
        };
      }

      if (parsed && typeof parsed === 'object' && typeof parsed.Status === 'string') {
        const status = parsed.Status.trim();
        if (status !== 'OK' && status !== 'Created') {
          const err =
            (typeof (parsed as any).Error === 'string' && (parsed as any).Error.trim().length > 0
              ? (parsed as any).Error.trim()
              : typeof (parsed as any).error === 'string' && (parsed as any).error.trim().length > 0
                ? (parsed as any).error.trim()
                : message && message.trim().length > 0
                  ? message.trim()
                  : `Status: ${status}`);
          return {
            success: false,
            error: err,
            data: parsed,
            httpStatus,
            durationMs,
            message: message || undefined,
          };
        }
      }

      return {
        success: true,
        data: parsed,
        httpStatus,
        durationMs,
        message: message || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // ==================== Player Management APIs ====================

  /**
   * 5.5.1 Create Player (Method: CU)
   * Creates a new player account in Joker system
   * Returns 200 if player exists, 201 if created
   */
  async createPlayer(username: string): Promise<JokerResponse & { data?: CreatePlayerResponse }> {
    return this.request('CU', { Username: username });
  }

  /**
   * 5.5.2 Set Player Status (Method: SS)
   * Status: 'Active' | 'Suspend'
   */
  async setPlayerStatus(
    username: string,
    status: 'Active' | 'Suspend'
  ): Promise<JokerResponse & { data?: SetPlayerStatusResponse }> {
    return this.request('SS', { Username: username, Status: status });
  }

  /**
   * 5.5.3 Set Player Password (Method: SP)
   */
  async setPlayerPassword(
    username: string,
    password: string
  ): Promise<JokerResponse & { data?: SetPlayerPasswordResponse }> {
    return this.request('SP', { Username: username, Password: password });
  }

  /**
   * 5.5.4 Logout Player (Method: SO)
   */
  async logoutPlayer(username: string): Promise<JokerResponse & { data?: LogoutPlayerResponse }> {
    return this.request('SO', { Username: username });
  }

  // ==================== Credit/Balance APIs ====================

  /**
   * 5.3.1 Get Credit (Method: GC)
   */
  async getCredit(username: string): Promise<JokerResponse & { data?: GetCreditResponse }> {
    return this.request('GC', { Username: username });
  }

  /**
   * 5.3.2 Transfer Credit (Method: TC)
   * Positive amount = deposit to player
   * Negative amount = withdraw from player
   */
  async transferCredit(
    username: string,
    amount: number,
    requestId: string
  ): Promise<JokerResponse & { data?: TransferCreditResponse }> {
    return this.request('TC', {
      Username: username,
      Amount: amount,
      RequestID: requestId,
    });
  }

  /**
   * 5.3.3 Verify Transfer (Method: TCH)
   * Check status of a previous transfer
   */
  async verifyTransfer(requestId: string): Promise<JokerResponse & { data?: VerifyTransferResponse }> {
    return this.request('TCH', { RequestID: requestId });
  }

  /**
   * 5.3.4 Withdraw All (Method: WAC)
   * Withdraw all remaining credit from player
   */
  async withdrawAll(username: string, requestId: string): Promise<JokerResponse & { data?: WithdrawAllResponse }> {
    return this.request('WAC', {
      Username: username,
      RequestID: requestId,
    });
  }

  // ==================== Game Launch APIs ====================

  /**
   * 5.1 Get Game List (Method: GL)
   */
  async getGameList(): Promise<JokerResponse & { data?: GetGameListResponse }> {
    return this.request('GL', {});
  }

  /**
   * 5.2 Launch Game (Method: LA)
   * mode: 0 = no transfer amount, 1 = with transfer amount
   */
  async launchGame(
    username: string,
    gameCode: string,
    options?: {
      mode?: 0 | 1;
      amount?: number;
      language?: string;
      template?: string;
    }
  ): Promise<JokerResponse & { data?: LaunchGameResponse }> {
    const body: any = {
      Username: username,
      GameCode: gameCode,
    };

    if (options?.mode !== undefined) {
      body.Mode = options.mode;
    }
    if (options?.amount !== undefined) {
      body.Amount = options.amount;
    }
    if (options?.language) {
      body.Language = options.language;
    }
    if (options?.template) {
      body.Template = options.template;
    }

    return this.request('LA', body);
  }

  // ==================== Transaction APIs ====================

  /**
   * 5.4.1 Get Transactions by Hour (Method: TS)
   */
  async getTransactionsByHour(
    startDate: string,
    endDate: string,
    options?: {
      nextId?: string;
      timezone?: string;
    }
  ): Promise<JokerResponse & { data?: GetTransactionsResponse }> {
    const body: any = {
      StartDate: startDate,
      EndDate: endDate,
      NextId: options?.nextId || '',
      Delay: 0,
    };

    return this.request('TS', body);
  }

  /**
   * 5.4.2 Get Transactions by Minute (Method: TSM)
   */
  async getTransactionsByMinute(
    startDate: string,
    endDate: string,
    options?: {
      nextId?: string;
      timezone?: string;
    }
  ): Promise<JokerResponse & { data?: GetTransactionsResponse }> {
    const body: any = {
      StartDate: startDate,
      EndDate: endDate,
      NextId: options?.nextId || '',
      Delay: 0,
    };

    return this.request('TSM', body, 20_000);
  }

  /**
   * 5.4.3 Get Win/Loss Data (Method: RWL)
   */
  async getWinloss(
    startDate: string,
    endDate: string,
    username?: string
  ): Promise<JokerResponse & { data?: GetWinlossResponse }> {
    const body: any = {
      StartDate: startDate,
      EndDate: endDate,
    };

    if (username) {
      body.Username = username;
    }

    return this.request('RWL', body);
  }

  /**
   * 5.4.4 Get History URL (Method: History)
   */
  async getHistoryUrl(
    ocode: string,
    options?: {
      language?: string;
      type?: string;
    }
  ): Promise<JokerResponse & { data?: GetHistoryUrlResponse }> {
    const body: any = {
      OCode: ocode,
      Type: options?.type || 'Game',
    };

    if (options?.language) {
      body.Language = options.language;
    }

    const resp = (await this.request('History', body)) as any;
    if (resp?.success && resp?.data && typeof resp.data.Url === 'string') {
      resp.data.Url = this.normalizeHistoryUrl(resp.data.Url);
    }
    return resp;
  }

  // ==================== Jackpot APIs (Optional) ====================

  /**
   * 5.6.1 Get Accumulated Jackpot (Method: JP)
   */
  async getJackpot(): Promise<JokerResponse & { data?: { Amount: number } }> {
    return this.request('JP', {});
  }

  /**
   * 5.6.2 Get Big Jackpot Winners (Method: GGJ)
   */
  async getJackpotWinners(): Promise<
    JokerResponse & {
      data?: Array<{
        Time: string;
        DisplayName: string;
        Amount: number;
        TargetCurrency: string;
      }>;
    }
  > {
    return this.request('GGJ', {});
  }

  // ==================== Free Credit APIs (Special Feature) ====================

  /**
   * 5.7.1 Transfer Free Credit (Method: TFC)
   */
  async transferFreeCredit(
    username: string,
    amount: number,
    requestId: string
  ): Promise<
    JokerResponse & {
      data?: {
        Username: string;
        RequestID: string;
        FreeCredit: number;
        BeforeFreeCredit: number;
        OutstandingFreeCredit: number;
        Time: string;
      };
    }
  > {
    return this.request('TFC', {
      Username: username,
      Amount: amount,
      RequestID: requestId,
    });
  }

  /**
   * 5.7.2 Verify Free Credit Transfer (Method: TFCH)
   */
  async verifyFreeCreditTransfer(
    requestId: string
  ): Promise<
    JokerResponse & {
      data?: {
        Username: string;
        RequestID: string;
        Amount: number;
        Time: string;
      };
    }
  > {
    return this.request('TFCH', { RequestID: requestId });
  }
}

export default JokerProvider;
