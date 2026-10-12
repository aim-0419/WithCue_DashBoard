import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminDashboardPage } from "./components/AdminDashboardPage.jsx";
import { AuthPage } from "./components/AuthPage.jsx";
import { CollectionPage, findLocalRealSenseCamera } from "./components/CollectionPage.jsx";
import { categoryPages, pageMeta } from "./data/dashboard-meta.js";
import { useDashboardData } from "./hooks/useDashboardData.js";
import { useIdleLogout } from "./hooks/useIdleLogout.js";
import {
  SESSION_STORAGE_KEYS,
  clearFirebaseSession,
  clearStoredSessions,
  isAdminClaims,
  isCollectorClaims,
  linkAdminProfile,
  loginAdminWithGoogle,
  loginUser,
  removeStoredCollectorProfile,
  restoreSession,
  signUpUser,
  storeCollectorProfile,
  subscribeAuthUser,
} from "./lib/auth-service.js";
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

const POSTURE_FILTERS = ["all", "correct", "incorrect"];
const VIEWS = ["dashboard", "login", "signup", "admin-login", "collect", "link-profile"];
const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function getViewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || "login";
  return VIEWS.includes(view) ? view : "login";
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

function navigateTo(paramsObject) {
  const params = new URLSearchParams(paramsObject);
  window.history.replaceState({}, "", `/?${params.toString()}`);
}

function getNextPostureFilter(currentPostureType) {
  const currentIndex = POSTURE_FILTERS.indexOf(currentPostureType);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % POSTURE_FILTERS.length : 0;
  return POSTURE_FILTERS[nextIndex];
}

// 화면 표시용 세션. 권한은 claims(role/roles/userDocId)에서만 가져온다.
function buildAdminSession(session, claims) {
  return {
    ...session,
    role: "admin",
    roles: claims.roles,
  };
}

function buildCollectorSession(session, claims) {
  return {
    ...session,
    role: "collector",
    roles: claims.roles,
    location: session?.location || "aim",
    postureType: "correct",
  };
}

function removeLegacyStoredProfiles() {
  // 이전 버전이 남긴 관리자 세션·개인정보 프로필 캐시는 더 이상 쓰지 않으므로 지운다.
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEYS.admin);
    window.localStorage.removeItem(SESSION_STORAGE_KEYS.legacyProfile);
  } catch {
    // 무시
  }
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState(getViewFromLocation());
  const [pageKey, setPageKey] = useState(getPageKeyFromLocation());
  const [postureFilter, setPostureFilter] = useState(getPostureFilterFromLocation());
  // Firebase ID 토큰 claims(role, roles, userDocId). 모든 권한 판정의 기준.
  const [authClaims, setAuthClaims] = useState(null);
  const [authSession, setAuthSession] = useState(null);
  const [collectorSession, setCollectorSession] = useState(null);
  const [authNotice, setAuthNotice] = useState("");
  const [preloadedRealSenseCamera, setPreloadedRealSenseCamera] = useState(undefined);
  const [adjustmentDrawerOpen, setAdjustmentDrawerOpen] = useState(false);
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false);
  const [deletingAdjustmentId, setDeletingAdjustmentId] = useState("");

  const hasAdminSession = Boolean(authSession) && isAdminClaims(authClaims);
  const isCollectorSession = Boolean(collectorSession) && isCollectorClaims(authClaims);
  const collectorCanOpenDashboard = isCollectorSession && isAdminClaims(authClaims);

  const { data, loading, refresh } = useDashboardData({ enabled: hasAdminSession });

  useEffect(() => {
    findLocalRealSenseCamera().then((camera) => {
      setPreloadedRealSenseCamera(camera);
    });
  }, []);

  // 시작 시 Firebase 로그인 상태와 claims로 세션을 복원한다. 없으면 저장된 표시용 프로필은 버린다.
  useEffect(() => {
    let cancelled = false;
    removeLegacyStoredProfiles();

    restoreSession()
      .catch(() => null)
      .then((restored) => {
        if (cancelled) {
          return;
        }

        if (!restored) {
          clearStoredSessions();
        } else if (restored.kind === "admin") {
          removeStoredCollectorProfile();
          setAuthClaims(restored.claims);
          setAuthSession(buildAdminSession(restored.session, restored.claims));
        } else {
          const nextCollectorSession = buildCollectorSession(restored.session, restored.claims);
          storeCollectorProfile(nextCollectorSession);
          setAuthClaims(restored.claims);
          setCollectorSession(nextCollectorSession);
        }

        setBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  const resetLocalSession = useCallback(() => {
    clearStoredSessions();
    setAuthClaims(null);
    setAuthSession(null);
    setCollectorSession(null);
    setAdjustmentDrawerOpen(false);
    setView("login");
    navigateTo({ view: "login" });
  }, []);

  // 다른 탭 로그아웃·세션 만료 등으로 Firebase 사용자가 사라지면 화면 세션도 정리한다.
  useEffect(() => {
    if (booting || (!authSession && !collectorSession)) {
      return undefined;
    }

    return subscribeAuthUser((user) => {
      // 로그아웃(null)뿐 아니라 다른 탭에서 다른 사용자로 로그인해 uid 가 바뀐 경우에도 화면 세션을 버린다.
      // 그대로 두면 이 탭은 이전 사용자 프로필을 보여 주면서 API 호출은 새 사용자로 나가 기록이 엇갈린다.
      if (!user || (authClaims?.uid && user.uid !== authClaims.uid)) {
        resetLocalSession();
      }
    });
  }, [authClaims, authSession, booting, collectorSession, resetLocalSession]);

  // 관리자 세션이 살아 있으면 항상 대시보드 흐름을 우선합니다(정보 연결 화면은 예외).
  useEffect(() => {
    if (booting || !authSession) {
      return;
    }

    if (!hasAdminSession) {
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
  }, [authSession, booting, hasAdminSession, view]);

  // 수집 세션이 있으면 로그인 화면 대신 바로 촬영 화면으로 복귀시킵니다.
  // 세션이 없으면 대시보드·수집·정보 연결 화면 요청은 로그인 화면으로 정규화합니다.
  useEffect(() => {
    if (booting || hasAdminSession) {
      return;
    }

    if (!isCollectorSession) {
      if (["collect", "dashboard", "link-profile"].includes(view)) {
        setView("login");
        navigateTo({ view: "login" });
      }

      return;
    }

    if (["login", "signup", "admin-login", "dashboard", "link-profile"].includes(view)) {
      setView("collect");
      navigateTo({ view: "collect" });
    }
  }, [booting, hasAdminSession, isCollectorSession, view]);

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

  async function handleLogin(form) {
    try {
      const result = await loginUser(form);

      if (!result.ok) {
        return result;
      }

      if (!isCollectorClaims(result.claims) || result.session?.userId !== result.claims.userDocId) {
        await clearFirebaseSession().catch(() => {});
        return {
          ok: false,
          message: "이 계정은 일반 수집 권한이 없습니다. 관리자 로그인으로 접근해 주세요.",
        };
      }

      const nextCollectorSession = buildCollectorSession(result.session, result.claims);

      setAuthNotice("");
      storeCollectorProfile(nextCollectorSession);
      setAuthClaims(result.claims);
      setAuthSession(null);
      setCollectorSession(nextCollectorSession);
      setView("collect");
      navigateTo({ view: "collect" });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "로그인 처리 중 알 수 없는 오류가 발생했습니다.",
      };
    }
  }

  async function handleAdminGoogleLogin() {
    try {
      const result = await loginAdminWithGoogle();

      if (!result.ok) {
        return result;
      }

      setAuthNotice("");
      removeStoredCollectorProfile();
      setAuthClaims(result.claims);
      setCollectorSession(null);
      setAuthSession(buildAdminSession(result.session, result.claims));
      setView("dashboard");
      setPageKey("main");
      setPostureFilter("all");
      navigateTo({ page: "main", posture: "all" });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "관리자 로그인 처리 중 알 수 없는 오류가 발생했습니다.",
      };
    }
  }

  // 관리자 계정에 본인 회원 정보를 연결한 뒤 바로 수집 화면으로 전환한다.
  async function handleLinkProfile(form) {
    try {
      const result = await linkAdminProfile(form);

      if (!result.ok) {
        return result;
      }

      const nextCollectorSession = buildCollectorSession(result.session, result.claims);

      storeCollectorProfile(nextCollectorSession);
      setAuthClaims(result.claims);
      setAuthSession(null);
      setCollectorSession(nextCollectorSession);
      setAdjustmentDrawerOpen(false);
      setView("collect");
      navigateTo({ view: "collect" });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "회원 정보 연결 중 알 수 없는 오류가 발생했습니다.",
      };
    }
  }

  function handleCancelLink() {
    setView("dashboard");
    navigateTo({ page: pageKey, posture: postureFilter });
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

  const handleLogout = useCallback(async () => {
    await clearFirebaseSession().catch(() => {});
    resetLocalSession();
  }, [resetLocalSession]);

  // 관리자와 수집 권한을 동시에 가진 계정은 다시 로그인하지 않고 화면만 전환합니다.
  // 아직 회원 정보가 연결되지 않은 관리자는 정보 연결 화면으로 보냅니다.
  const handleGoToCollectorLogin = useCallback(() => {
    if (!authSession || !isAdminClaims(authClaims)) {
      return;
    }

    setAdjustmentDrawerOpen(false);

    if (!isCollectorClaims(authClaims) || authSession.userId !== authClaims.userDocId) {
      setView("link-profile");
      navigateTo({ view: "link-profile" });
      return;
    }

    const nextCollectorSession = buildCollectorSession(authSession, authClaims);

    storeCollectorProfile(nextCollectorSession);
    setAuthSession(null);
    setCollectorSession(nextCollectorSession);
    setView("collect");
    navigateTo({ view: "collect" });
  }, [authClaims, authSession]);

  const handleOpenDashboardFromCollector = useCallback(() => {
    if (!collectorSession || !isAdminClaims(authClaims)) {
      return;
    }

    removeStoredCollectorProfile();
    setAuthSession(buildAdminSession(collectorSession, authClaims));
    setCollectorSession(null);
    setView("dashboard");
    setPageKey("main");
    setPostureFilter("all");
    navigateTo({ page: "main", posture: "all" });
  }, [authClaims, collectorSession]);

  const logoutCountdownLabel = useIdleLogout({
    enabled: isCollectorSession && view === "collect",
    onLogout: handleLogout,
  });

  // 관리자 대시보드는 30분 무반응 시 로그아웃합니다(카운트다운은 표시하지 않음).
  useIdleLogout({
    enabled: hasAdminSession,
    onLogout: handleLogout,
    timeoutMs: ADMIN_IDLE_TIMEOUT_MS,
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
    if (booting) {
      return;
    }

    if (hasAdminSession) {
      document.title =
        view === "link-profile"
          ? "WithCue 관리자 대시보드 - 수집 참여자 정보 연결"
          : `WithCue 관리자 대시보드 - ${currentPage.title}`;
      return;
    }

    if (isCollectorSession) {
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
  }, [booting, currentPage.title, hasAdminSession, isCollectorSession, view]);

  if (booting) {
    return (
      <main className="dashboard dashboard--auth" aria-busy="true">
        <p className="auth-boot">로그인 상태를 확인하고 있습니다.</p>
      </main>
    );
  }

  if (hasAdminSession && view === "link-profile") {
    return (
      <AuthPage
        mode="link-profile"
        onLinkProfile={handleLinkProfile}
        onCancelLink={handleCancelLink}
      />
    );
  }

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
        canGoToCollectorLogin
        onGoToCollectorLogin={handleGoToCollectorLogin}
        onLogout={handleLogout}
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

  if (isCollectorSession) {
    return (
      <CollectionPage
        session={collectorSession}
        onLogout={handleLogout}
        logoutCountdownLabel={logoutCountdownLabel}
        canOpenDashboard={collectorCanOpenDashboard}
        onOpenDashboard={handleOpenDashboardFromCollector}
        initialRealSenseCamera={preloadedRealSenseCamera}
      />
    );
  }

  return (
    <AuthPage
      mode={view}
      notice={authNotice}
      onLogin={handleLogin}
      onSignup={handleSignup}
      onAdminGoogleLogin={handleAdminGoogleLogin}
    />
  );
}
