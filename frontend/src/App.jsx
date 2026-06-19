import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminDashboardPage } from "./components/AdminDashboardPage.jsx";
import { AuthPage } from "./components/AuthPage.jsx";
import { CollectionPage, findLocalRealSenseCamera } from "./components/CollectionPage.jsx";
import { categoryPages, pageMeta } from "./data/dashboard-meta.js";
import { useDashboardData } from "./hooks/useDashboardData.js";
import { useIdleLogout } from "./hooks/useIdleLogout.js";
import { clearFirebaseSession, loginUser, signUpUser } from "./lib/auth-service.js";
import {
  getDisplayedConsentCount,
  getDisplayedSessionCount,
  getFilteredLocations,
  sumBodyParts,
} from "./lib/dashboard-selectors.js";
import {
  createLegacyAdjustment,
  deleteLegacyAdjustment,
} from "./lib/legacy-adjustments-service.js";

const AUTH_PROFILE_KEY = "withcue-auth-profile";
const AUTH_ADMIN_SESSION_KEY = "withcue-admin-session";
const AUTH_COLLECTOR_SESSION_KEY = "withcue-collector-session";
const POSTURE_FILTERS = ["all", "correct", "incorrect"];

function getSessionRoles(session) {
  if (Array.isArray(session?.roles) && session.roles.length > 0) {
    return session.roles;
  }

  if (session?.role === "admin") {
    return ["admin"];
  }

  if (session?.role === "collector") {
    return ["collector"];
  }

  return [];
}

function getViewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || "login";
  return ["dashboard", "login", "signup", "admin-login", "collect"].includes(view)
    ? view
    : "login";
}

function getPageKeyFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page") || "main";
  return pageMeta[page] ? page : "main";
}

function getPostureFilterFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const posture = params.get("posture") || "all";
  return POSTURE_FILTERS.includes(posture) ? posture : "all";
}

function readJsonFromStorage(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function navigateTo(paramsObject) {
  const params = new URLSearchParams(paramsObject);
  window.history.replaceState({}, "", `/?${params.toString()}`);
}

function persistCollectorSession(session) {
  window.localStorage.setItem(AUTH_COLLECTOR_SESSION_KEY, JSON.stringify(session));
}

function getNextPostureFilter(currentPostureType) {
  const currentIndex = POSTURE_FILTERS.indexOf(currentPostureType);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % POSTURE_FILTERS.length : 0;
  return POSTURE_FILTERS[nextIndex];
}

export default function App() {
  const [view, setView] = useState(getViewFromLocation());
  const [pageKey, setPageKey] = useState(getPageKeyFromLocation());
  const [postureFilter, setPostureFilter] = useState(getPostureFilterFromLocation());
  const [authProfile, setAuthProfile] = useState(() => readJsonFromStorage(AUTH_PROFILE_KEY));
  const [authSession, setAuthSession] = useState(() => readJsonFromStorage(AUTH_ADMIN_SESSION_KEY));
  const [collectorSession, setCollectorSession] = useState(() =>
    readJsonFromStorage(AUTH_COLLECTOR_SESSION_KEY),
  );
  const [authNotice, setAuthNotice] = useState("");
  const [preloadedRealSenseCamera, setPreloadedRealSenseCamera] = useState(undefined);
  const [adjustmentDrawerOpen, setAdjustmentDrawerOpen] = useState(false);
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false);
  const [deletingAdjustmentId, setDeletingAdjustmentId] = useState("");
  const { data, loading, refresh } = useDashboardData();

  useEffect(() => {
    findLocalRealSenseCamera().then((camera) => {
      setPreloadedRealSenseCamera(camera);
    });
  }, []);

  const sessionRoles = getSessionRoles(authSession);
  const hasAdminSession = sessionRoles.includes("admin");
  const adminCanOpenCollector = sessionRoles.includes("collector");
  const isCollectorSession = Boolean(collectorSession);
  const collectorCanOpenDashboard = getSessionRoles(collectorSession).includes("admin");

  useEffect(() => {
    const handleLocationChange = () => {
      setView(getViewFromLocation());
      setPageKey(getPageKeyFromLocation());
      setPostureFilter(getPostureFilterFromLocation());
    };

    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  // 관리자 세션이 살아 있으면 항상 대시보드 흐름을 우선합니다.
  useEffect(() => {
    if (!authSession) {
      return;
    }

    if (!hasAdminSession) {
      window.localStorage.removeItem(AUTH_ADMIN_SESSION_KEY);
      setAuthSession(null);
      setView("login");
      navigateTo({ view: "login" });
      return;
    }

    if (["login", "signup", "admin-login", "collect"].includes(view)) {
      setView("dashboard");
      setPageKey("main");
      setPostureFilter("all");
      navigateTo({ page: "main", posture: "all" });
    }
  }, [authSession, hasAdminSession, view]);

  // 수집 세션이 있으면 로그인 화면 대신 바로 촬영 화면으로 복귀시킵니다.
  useEffect(() => {
    if (hasAdminSession) {
      return;
    }

    if (!collectorSession && view === "collect") {
      setView("login");
      navigateTo({ view: "login" });
      return;
    }

    if (!collectorSession) {
      return;
    }

    if (["login", "signup", "admin-login"].includes(view)) {
      setView("collect");
      navigateTo({ view: "collect" });
    }
  }, [collectorSession, hasAdminSession, view]);

  const dashboardData = data ?? {
    source: "loading",
    updatedAt: "",
    locations: [],
    recentAdjustments: [],
  };

  const currentPage = pageMeta[pageKey] || pageMeta.main;
  const pageLocationName = categoryPages[pageKey]?.matchName;

  const filteredLocations = useMemo(
    () => getFilteredLocations(dashboardData.locations, pageLocationName),
    [dashboardData.locations, pageLocationName],
  );

  const displayedConsentCount = useMemo(
    () =>
      getDisplayedConsentCount(
        filteredLocations,
        pageKey === "main" ? dashboardData.ConsentUserIds : null,
      ),
    [dashboardData.ConsentUserIds, filteredLocations, pageKey],
  );

  const displayedSessionCount = useMemo(
    () => getDisplayedSessionCount(filteredLocations, postureFilter),
    [filteredLocations, postureFilter],
  );

  const displayedBodyParts = useMemo(
    () => sumBodyParts(filteredLocations, postureFilter),
    [filteredLocations, postureFilter],
  );

  async function handleSignup(form) {
    try {
      const result = await signUpUser(form);

      if (!result.ok) {
        return result;
      }

      const profile = result.profile;
      window.localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(profile));
      setAuthProfile(profile);
      setAuthNotice(result.message || "회원가입이 완료됐습니다. 같은 정보로 로그인해 주세요.");
      setView("login");
      navigateTo({ view: "login" });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "회원가입 처리 중 알 수 없는 오류가 발생했습니다.",
      };
    }
  }

  async function handleLogin(form, mode) {
    try {
      const result = await loginUser(form);

      if (!result.ok) {
        return result;
      }

      const session = result.session;
      const nextSessionRoles = getSessionRoles(session);

      if (mode === "admin-login" && !nextSessionRoles.includes("admin")) {
        return {
          ok: false,
          message: "관리자 대시보드는 관리자 계정으로만 접근할 수 있습니다.",
        };
      }

      if (mode !== "admin-login" && !nextSessionRoles.includes("collector")) {
        return {
          ok: false,
          message: "이 계정은 일반 수집 권한이 없습니다. 관리자 로그인으로 접근해 주세요.",
        };
      }

      setAuthNotice("");
      window.localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(session));
      setAuthProfile(session);

      if (mode === "admin-login") {
        const adminSession = { ...session, role: "admin", roles: nextSessionRoles };
        window.localStorage.setItem(AUTH_ADMIN_SESSION_KEY, JSON.stringify(adminSession));
        window.localStorage.removeItem(AUTH_COLLECTOR_SESSION_KEY);
        setCollectorSession(null);
        setAuthSession(adminSession);
        setView("dashboard");
        setPageKey("main");
        setPostureFilter("all");
        navigateTo({ page: "main", posture: "all" });
      } else {
        const collectorSessionData = {
          ...session,
          role: nextSessionRoles.includes("collector") ? "collector" : session.role,
          roles: nextSessionRoles,
          postureType: "correct",
        };

        window.localStorage.removeItem(AUTH_ADMIN_SESSION_KEY);
        persistCollectorSession(collectorSessionData);
        setAuthSession(null);
        setCollectorSession(collectorSessionData);
        setView("collect");
        navigateTo({ view: "collect" });
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "로그인 처리 중 알 수 없는 오류가 발생했습니다.",
      };
    }
  }

  function handleNavigatePage(nextPageKey) {
    setPageKey(nextPageKey);
    setView("dashboard");
    navigateTo({ page: nextPageKey, posture: postureFilter });
  }

  function handleChangePostureType(nextPostureType) {
    setPostureFilter(nextPostureType);
    setView("dashboard");
    navigateTo({ page: pageKey, posture: nextPostureType });
  }

  function handleCyclePostureType() {
    const nextPostureType = getNextPostureFilter(postureFilter);
    handleChangePostureType(nextPostureType);
  }

  const handleAdminLogout = useCallback(async () => {
    await clearFirebaseSession().catch(() => {});
    window.localStorage.removeItem(AUTH_ADMIN_SESSION_KEY);
    setAuthSession(null);
    setAdjustmentDrawerOpen(false);
    setView("login");
    navigateTo({ view: "login" });
  }, []);

  const handleCollectorLogout = useCallback(async () => {
    await clearFirebaseSession().catch(() => {});
    window.localStorage.removeItem(AUTH_COLLECTOR_SESSION_KEY);
    setCollectorSession(null);
    setView("login");
    navigateTo({ view: "login" });
  }, []);

  // 관리자와 수집 권한을 동시에 가진 계정은 다시 로그인하지 않고 화면만 전환합니다.
  const handleGoToCollectorLogin = useCallback(() => {
    if (!authSession || !getSessionRoles(authSession).includes("collector")) {
      return;
    }

    const collectorSessionData = {
      ...authSession,
      role: "collector",
      roles: getSessionRoles(authSession),
      postureType: "correct",
    };

    window.localStorage.removeItem(AUTH_ADMIN_SESSION_KEY);
    persistCollectorSession(collectorSessionData);
    setAuthSession(null);
    setCollectorSession(collectorSessionData);
    setAdjustmentDrawerOpen(false);
    setView("collect");
    navigateTo({ view: "collect" });
  }, [authSession]);

  const handleOpenDashboardFromCollector = useCallback(() => {
    if (!collectorSession || !getSessionRoles(collectorSession).includes("admin")) {
      return;
    }

    const adminSession = {
      ...collectorSession,
      role: "admin",
      roles: getSessionRoles(collectorSession),
    };

    window.localStorage.setItem(AUTH_ADMIN_SESSION_KEY, JSON.stringify(adminSession));
    window.localStorage.removeItem(AUTH_COLLECTOR_SESSION_KEY);
    setAuthSession(adminSession);
    setCollectorSession(null);
    setView("dashboard");
    setPageKey("main");
    setPostureFilter("all");
    navigateTo({ page: "main", posture: "all" });
  }, [collectorSession]);

  const logoutCountdownLabel = useIdleLogout({
    enabled: isCollectorSession && view === "collect",
    onLogout: handleCollectorLogout,
  });

  const handleSubmitAdjustment = useCallback(
    async (form) => {
      setAdjustmentSubmitting(true);

      try {
        await createLegacyAdjustment({
          adminSession: authSession,
          location: form.location,
          bodyPartKey: form.bodyPartKey,
          postureType: form.postureType,
          sessionDelta: form.sessionDelta,
          consentDelta: form.consentDelta,
          note: form.note,
          targetUser: form.targetUser,
        });
        await refresh();
      } finally {
        setAdjustmentSubmitting(false);
      }
    },
    [authSession, refresh],
  );

  const handleDeleteAdjustment = useCallback(
    async (adjustmentId) => {
      setDeletingAdjustmentId(adjustmentId);

      try {
        await deleteLegacyAdjustment(adjustmentId);
        await refresh();
      } finally {
        setDeletingAdjustmentId("");
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (hasAdminSession) {
      document.title = `WithCue 관리자 대시보드 - ${currentPage.title}`;
      return;
    }

    if (collectorSession) {
      document.title = "WithCue 데이터 수집";
      return;
    }

    if (view === "signup") {
      document.title = "WithCue 데이터 수집 - 회원가입";
      return;
    }

    if (view === "admin-login") {
      document.title = "WithCue 관리자 대시보드 - 관리자 로그인";
      return;
    }

    document.title = "WithCue 데이터 수집 - 로그인";
  }, [collectorSession, currentPage.title, hasAdminSession, view]);

  if (hasAdminSession) {
    return (
      <AdminDashboardPage
        currentPage={currentPage}
        pageKey={pageKey}
        postureType={postureFilter}
        displayedSessionCount={displayedSessionCount}
        displayedConsentCount={displayedConsentCount}
        filteredLocations={filteredLocations}
        dashboardData={dashboardData}
        displayedBodyParts={displayedBodyParts}
        loading={loading}
        onNavigatePage={handleNavigatePage}
        onChangePostureType={handleChangePostureType}
        onCyclePostureType={handleCyclePostureType}
        canGoToCollectorLogin={adminCanOpenCollector}
        onGoToCollectorLogin={handleGoToCollectorLogin}
        onLogout={handleAdminLogout}
        adjustmentDrawerOpen={adjustmentDrawerOpen}
        onOpenAdjustmentDrawer={() => setAdjustmentDrawerOpen(true)}
        onCloseAdjustmentDrawer={() => setAdjustmentDrawerOpen(false)}
        onSubmitAdjustment={handleSubmitAdjustment}
        onDeleteAdjustment={handleDeleteAdjustment}
        adjustmentSubmitting={adjustmentSubmitting}
        deletingAdjustmentId={deletingAdjustmentId}
      />
    );
  }

  if (collectorSession) {
    return (
      <CollectionPage
        session={collectorSession}
        profile={authProfile}
        onLogout={handleCollectorLogout}
        logoutCountdownLabel={logoutCountdownLabel}
        canOpenDashboard={collectorCanOpenDashboard}
        onOpenDashboard={handleOpenDashboardFromCollector}
        initialRealSenseCamera={preloadedRealSenseCamera}
      />
    );
  }

  return (
    <AuthPage mode={view} notice={authNotice} onLogin={handleLogin} onSignup={handleSignup} />
  );
}
