import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import type { DeckApi } from "@/core/api";

import { useServers } from "./servers";

/** API сервера: создаёт сессию (проверяет закреплённый ключ, загружает ключи устройства). */
export function useApi(sid: string) {
  const { api } = useServers();
  const [state, setState] = useState<{ api: DeckApi | null; error: string | null }>({ api: null, error: null });
  useEffect(() => {
    let alive = true;
    api(sid).then(
      (a) => alive && setState({ api: a, error: null }),
      (e) => alive && setState({ api: null, error: e?.message || String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, sid]);
  return state;
}

/**
 * Загрузка данных при открытии экрана и по «потянуть, чтобы обновить».
 * fn — мемоизированная функция; возвращает null, пока загружать нечего (нет сессии).
 */
export function useLoad<T>(fn: () => Promise<T> | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback(async () => {
    const pr = fn();
    if (!pr) return;
    try {
      const v = await pr;
      setData(v);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [fn]);

  useFocusEffect(
    useCallback(() => {
      run();
    }, [run]),
  );

  const reload = useCallback(async () => {
    setRefreshing(true);
    await run();
    setRefreshing(false);
  }, [run]);

  return { data, error, loading: refreshing, reload, setData };
}
