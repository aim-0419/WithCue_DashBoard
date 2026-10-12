import { useEffect, useRef, useState } from "react";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function formatLogoutCountdown(remainingSeconds) {
  const safeSeconds = Math.max(0, remainingSeconds);
  const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, "0");
  const seconds = String(safeSeconds % 60).padStart(2, "0");
  return `자동 로그아웃까지 ${minutes}:${seconds}`;
}

export function useIdleLogout({ enabled, onLogout, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS }) {
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const idleDeadlineRef = useRef(0);
  const idleLogoutPendingRef = useRef(false);

  useEffect(() => {
    // 활성화된 세션에서만 무반응 기준 시간을 새로 잡음.
    if (!enabled) {
      idleDeadlineRef.current = 0;
      idleLogoutPendingRef.current = false;
      setRemainingSeconds(0);
      return;
    }

    const resetIdleDeadline = () => {
      idleDeadlineRef.current = Date.now() + timeoutMs;
    };

    resetIdleDeadline();
    setRemainingSeconds(Math.ceil(timeoutMs / 1000));

    const activityEvents = ["pointerdown", "mousemove", "keydown", "scroll", "touchstart"];
    const handleActivity = () => {
      if (idleLogoutPendingRef.current) {
        return;
      }

      resetIdleDeadline();
    };

    activityEvents.forEach((eventName) =>
      window.addEventListener(eventName, handleActivity, { passive: true }),
    );

    return () => {
      activityEvents.forEach((eventName) =>
        window.removeEventListener(eventName, handleActivity),
      );
    };
  }, [enabled, timeoutMs]);

  useEffect(() => {
    // 1초마다 남은 시간을 갱신하고 만료 시 로그아웃함.
    if (!enabled) {
      return undefined;
    }

    const tick = () => {
      const remainingMs = Math.max(0, idleDeadlineRef.current - Date.now());
      const nextRemainingSeconds = Math.ceil(remainingMs / 1000);
      setRemainingSeconds(nextRemainingSeconds);

      if (remainingMs > 0 || idleLogoutPendingRef.current) {
        return;
      }

      idleLogoutPendingRef.current = true;
      Promise.resolve(onLogout()).finally(() => {
        idleLogoutPendingRef.current = false;
      });
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [enabled, onLogout]);

  return enabled ? formatLogoutCountdown(remainingSeconds) : "";
}
