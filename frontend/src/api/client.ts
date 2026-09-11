import { z } from "zod";
import {
  ApiErrorResponseSchema,
  AppSettingsResponseSchema,
  AuthStatusResponseSchema,
  EmptyResponseSchema,
  InstrumentWithMappingsSchema,
  LatestPriceSchema,
  RecentAlertSchema,
  RuntimeResponseSchema,
  SourceErrorSchema,
  SymbolQueryResponseSchema,
  TelegramTestResponseSchema,
  serializeInstrumentLevelsForApi,
} from "./schemas";
import type {
  AuthStatusResponse,
  AppSettingsResponse,
  CreateInstrumentRequest,
  InstrumentWithMappings,
  LatestPrice,
  RecentAlert,
  RuntimeResponse,
  SourceError,
  SymbolOption,
  TelegramTestResponse,
  SetupRequest,
  UpdateSettingsRequest,
} from "./schemas";

export type {
  AppSettingsResponse,
  AuthStatusResponse,
  CreateInstrumentRequest,
  InstrumentWithMappings,
  LatestPrice,
  RecentAlert,
  RuntimeResponse,
  SourceError,
  SymbolOption,
  SetupRequest,
  UpdateSettingsRequest,
  TelegramTestResponse,
} from "./schemas";
export { serializeInstrumentLevelsForApi } from "./schemas";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {

  private requestInit(signal?: AbortSignal, init: RequestInit = {}): RequestInit {
    return {
      cache: "no-store",
      ...init,
      ...(signal === undefined ? {} : { signal }),
    };
  }


  private async fetch<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: RequestInit,
  ): Promise<T> {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let message = `API request failed: ${response.statusText}`;
      try {
        const data: unknown = await response.json();
        const result = ApiErrorResponseSchema.safeParse(data);
        if (result.success) {
          message = result.data.detail;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
      }
      throw new ApiError(response.status, message);
    }

    if (response.status === 204) {
      const result = schema.safeParse({});
      if (!result.success) {
        throw new ApiError(500, `Invalid API response: ${result.error.message}`);
      }
      return result.data;
    }

    const data: unknown = await response.json();
    const result = schema.safeParse(data);

    if (!result.success) {
      throw new ApiError(500, `Invalid API response: ${result.error.message}`);
    }

    return result.data;
  }

  async getAuthSession(signal?: AbortSignal): Promise<AuthStatusResponse> {
    return this.fetch("/api/auth/session", AuthStatusResponseSchema, this.requestInit(signal));
  }

  async login(password: string, signal?: AbortSignal): Promise<AuthStatusResponse> {
    return this.fetch(
      "/api/auth/login",
      AuthStatusResponseSchema,
      this.requestInit(signal, { method: "POST", body: JSON.stringify({ password }) }),
    );
  }

  async logout(signal?: AbortSignal): Promise<AuthStatusResponse> {
    return this.fetch(
      "/api/auth/logout",
      AuthStatusResponseSchema,
      this.requestInit(signal, { method: "POST" }),
    );
  }
  async setup(data: SetupRequest, signal?: AbortSignal): Promise<AuthStatusResponse> {
    return this.fetch(
      "/api/setup",
      AuthStatusResponseSchema,
      this.requestInit(signal, { method: "POST", body: JSON.stringify(data) }),
    );
  }

  async getSettings(signal?: AbortSignal): Promise<AppSettingsResponse> {
    return this.fetch("/api/settings", AppSettingsResponseSchema, this.requestInit(signal));
  }

  async updateSettings(
    data: UpdateSettingsRequest,
    signal?: AbortSignal,
  ): Promise<AppSettingsResponse> {
    return this.fetch(
      "/api/settings",
      AppSettingsResponseSchema,
      this.requestInit(signal, { method: "PUT", body: JSON.stringify(data) }),
    );
  }

  async getRuntime(signal?: AbortSignal): Promise<RuntimeResponse> {
    return this.fetch("/api/runtime", RuntimeResponseSchema, this.requestInit(signal));
  }

  async refreshPrices(signal?: AbortSignal): Promise<void> {
    await this.fetch(
      "/api/prices/refresh",
      EmptyResponseSchema,
      this.requestInit(signal, { method: "POST" }),
    );
  }

  async getLatestPrices(signal?: AbortSignal): Promise<readonly LatestPrice[]> {
    return this.fetch("/api/prices/latest", z.array(LatestPriceSchema), this.requestInit(signal));
  }

  async getRecentAlerts(signal?: AbortSignal): Promise<readonly RecentAlert[]> {
    return this.fetch("/api/alerts", z.array(RecentAlertSchema), this.requestInit(signal));
  }

  async getSourceErrors(signal?: AbortSignal): Promise<readonly SourceError[]> {
    return this.fetch("/api/source-errors", z.array(SourceErrorSchema), this.requestInit(signal));
  }

  async testTelegram(signal?: AbortSignal): Promise<TelegramTestResponse> {
    return this.fetch(
      "/api/telegram/test",
      TelegramTestResponseSchema,
      this.requestInit(signal, { method: "POST" }),
    );
  }

  async querySymbols(
    provider: string,
    marketType: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly SymbolOption[]> {
    const params = new URLSearchParams({ provider, market_type: marketType, q: query });
    const response = await this.fetch(
      `/api/symbols/query?${params.toString()}`,
      SymbolQueryResponseSchema,
      this.requestInit(signal),
    );
    return response.options;
  }

  async getInstruments(signal?: AbortSignal): Promise<readonly InstrumentWithMappings[]> {
    return this.fetch(
      "/api/instruments",
      z.array(InstrumentWithMappingsSchema),
      this.requestInit(signal),
    );
  }

  async getInstrument(id: number | string, signal?: AbortSignal): Promise<InstrumentWithMappings> {
    const numericId = typeof id === "string" ? Number(id) : id;
    const instruments = await this.getInstruments(signal);
    const match = instruments.find((item) => item.id === numericId);
    if (match === undefined) {
      throw new ApiError(404, `Instrument ${id} not found`);
    }
    return match;
  }

  async createInstrument(
    data: CreateInstrumentRequest,
    signal?: AbortSignal,
  ): Promise<InstrumentWithMappings> {
    return this.fetch(
      "/api/instruments",
      InstrumentWithMappingsSchema,
      this.requestInit(signal, {
        method: "POST",
        body: JSON.stringify(serializeInstrumentLevelsForApi(data)),
      }),
    );
  }

  async updateInstrument(
    id: number | string,
    data: CreateInstrumentRequest,
    signal?: AbortSignal,
  ): Promise<InstrumentWithMappings> {
    return this.fetch(
      `/api/instruments/${id}`,
      InstrumentWithMappingsSchema,
      this.requestInit(signal, {
        method: "PUT",
        body: JSON.stringify(serializeInstrumentLevelsForApi(data)),
      }),
    );
  }

  async patchInstrumentEnabled(
    id: number | string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<InstrumentWithMappings> {
    return this.fetch(
      `/api/instruments/${id}`,
      InstrumentWithMappingsSchema,
      this.requestInit(signal, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    );
  }

  async deleteInstrument(id: number | string, signal?: AbortSignal): Promise<void> {
    await this.fetch(
      `/api/instruments/${id}`,
      EmptyResponseSchema,
      this.requestInit(signal, { method: "DELETE" }),
    );
  }
}

export const apiClient = new ApiClient();
