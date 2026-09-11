import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { apiClient, ApiError } from "../../api/client";
import type { SymbolOption } from "../../api/client";

const SEARCH_DEBOUNCE_MS = 250;

type Props = {
  id: string;
  provider: string;
  marketType: string;
  value: string;
  onChange: (value: string) => void;
};

export function SymbolInput({ id, provider, marketType, value, onChange }: Props) {
  const listboxId = useId();
  const suppressListRef = useRef(false);
  const [options, setOptions] = useState<readonly SymbolOption[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);
  const trimmedValue = value.trim();
  const listVisible = isActive && options.length > 0;

  useEffect(() => {
    if (!isActive || trimmedValue.length === 0 || trimmedValue === selectedSymbol) {
      setOptions([]);
      setState("idle");
      setMessage(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState("loading");
    setMessage(null);

    const timeout = window.setTimeout(async () => {
      try {
        const result = await apiClient.querySymbols(provider, marketType, trimmedValue, controller.signal);
        if (cancelled) {
          return;
        }
        if (suppressListRef.current) {
          suppressListRef.current = false;
          setOptions([]);
        } else {
          setOptions(result);
        }
        setState("ready");
        setMessage(result.length === 0 ? "没有匹配的 Symbol，可继续手动输入。" : null);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setOptions([]);
        setState("error");
        setMessage(error instanceof ApiError ? error.message : "Symbol 查询失败，可继续手动输入。");
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isActive, marketType, provider, selectedSymbol, trimmedValue]);

  function selectOption(symbol: string) {
    suppressListRef.current = true;
    setSelectedSymbol(symbol.trim());
    onChange(symbol);
    setOptions([]);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsActive(false);
      setOptions([]);
    }
  }

  return (
    <div
      className={`symbol-combobox${listVisible ? " symbol-combobox--open" : ""}`}
      onBlur={handleBlur}
    >
      <input
        id={id}
        type="text"
        value={value}
        onFocus={() => setIsActive(true)}
        onChange={(event) => {
          suppressListRef.current = false;
          setSelectedSymbol(null);
          setIsActive(true);
          onChange(event.target.value);
        }}
        placeholder="例如 BTCUSDT"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={listVisible}
      />
      {state === "loading" && <p className="field-hint" role="status">正在查询 Symbol...</p>}
      {message && <p className={state === "error" ? "field-hint field-hint--error" : "field-hint"}>{message}</p>}
      {listVisible && (
        <ul id={listboxId} className="symbol-options" role="listbox" aria-label="Symbol 候选项">
          {options.map((option) => (
            <li key={`${option.provider}-${option.market_type}-${option.symbol}`} role="presentation">
              <button
                type="button"
                role="option"
                className="symbol-option"
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectOption(option.symbol);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}