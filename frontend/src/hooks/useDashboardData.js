import { useCallback, useEffect, useState } from "react";
import { getDashboardData } from "../lib/dashboard-service.js";

// enabled(관리자 세션)일 때만 서버에서 대시보드 데이터를 불러온다.
export function useDashboardData({ enabled = false } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setLoading(true);
    const nextData = await getDashboardData();
    setData(nextData);
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      // 로그아웃 뒤 다른 계정에 이전 집계가 보이지 않도록 비운다.
      setData(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      const nextData = await getDashboardData();

      if (!cancelled) {
        setData(nextData);
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // enabled로 바뀐 직후 첫 렌더에서도 로딩 상태로 보이게 한다.
  return { data, loading: enabled && (loading || data === null), refresh };
}
