import { useEffect, useMemo, useRef, useState } from "react";
import {
  BODY_PART_OPTIONS,
  buildRecordingFileName,
  ensureCollectorConsentAtLocation,
  formatBirthDateChip,
  formatGenderLabel,
  formatPostureLabel,
  getLocationChipLabel,
  saveCollectionRecording,
} from "../lib/collection-service.js";

const AUTH_COLLECTOR_SESSION_KEY = "withcue-collector-session";
const RECORDER_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];
const LOCAL_BACKEND_ORIGIN =
  import.meta.env.VITE_LOCAL_CAMERA_BACKEND_ORIGIN || "http://127.0.0.1:5000";
const REALSENSE_CAMERA_INDEX = -100;
const REALSENSE_DEVICE_ID = "local-realsense-depth";
const REALSENSE_BODY_PART_NAMES = {
  Neck: "목",
  Hip: "허리",
  LeftShoulder: "왼쪽 어깨",
  RightShoulder: "오른쪽 어깨",
  LeftKnee: "왼쪽 무릎",
  RightKnee: "오른쪽 무릎",
};
const MANUAL_VIDEO_SOURCES = {
  Neck: "/assets/manuals/Video/Neck.mp4",
  Hip: "/assets/manuals/Video/Hip.mp4",
  LeftShoulder: "/assets/manuals/Video/Shoulder.mp4",
  RightShoulder: "/assets/manuals/Video/Shoulder.mp4",
  LeftKnee: "/assets/manuals/Video/Knee.mp4",
  RightKnee: "/assets/manuals/Video/Knee.mp4",
};

function getSupportedMimeType() {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
    return "";
  }

  return (
    RECORDER_CANDIDATES.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || ""
  );
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${LOCAL_BACKEND_ORIGIN}${path}`, options);
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || "로컬 카메라 서버 요청에 실패했습니다.");
  }

  return result;
}

async function findLocalRealSenseCamera() {
  try {
    const result = await fetchJson("/api/cameras");
    const camera = (result.cameras || []).find(
      (device) => device.index === REALSENSE_CAMERA_INDEX || device.depth,
    );

    if (!camera) {
      return null;
    }

    return {
      deviceId: REALSENSE_DEVICE_ID,
      label: camera.label || "Intel RealSense RGB+Depth",
      isRealSense: true,
    };
  } catch {
    return null;
  }
}

function getBodyPartOption(bodyPartKey) {
  return BODY_PART_OPTIONS.find((option) => option.key === bodyPartKey) || BODY_PART_OPTIONS[0];
}

export function CollectionPage({
  session,
  profile,
  onLogout,
  logoutCountdownLabel,
  canOpenDashboard,
  onOpenDashboard,
}) {
  const videoRef = useRef(null);
  const serverPreviewRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordingStartedAtRef = useRef(0);

  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [cameraDevices, setCameraDevices] = useState([]);
  const [localRealSenseCamera, setLocalRealSenseCamera] = useState(null);
  const [selectedBodyPartKey, setSelectedBodyPartKey] = useState("Neck");
  const [selectedPostureType, setSelectedPostureType] = useState(
    session?.postureType === "incorrect" ? "incorrect" : "correct",
  );
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("카메라를 준비하고 있습니다.");
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [manualBodyPartKey, setManualBodyPartKey] = useState("");
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [manualVideoFailed, setManualVideoFailed] = useState(false);

  const displayProfile = profile || session;
  const activeSession = useMemo(
    () => ({
      ...session,
      postureType: selectedPostureType,
    }),
    [selectedPostureType, session],
  );
  const activeBodyPart = useMemo(
    () => getBodyPartOption(selectedBodyPartKey),
    [selectedBodyPartKey],
  );
  const manualBodyPart = useMemo(
    () => getBodyPartOption(manualBodyPartKey || selectedBodyPartKey),
    [manualBodyPartKey, selectedBodyPartKey],
  );
  const manualVideoSource = MANUAL_VIDEO_SOURCES[manualBodyPart.key] || "";
  const cameraDeviceOptions = useMemo(
    () => (localRealSenseCamera ? [localRealSenseCamera, ...cameraDevices] : cameraDevices),
    [cameraDevices, localRealSenseCamera],
  );
  const isLocalRealSenseSelected = selectedDeviceId === REALSENSE_DEVICE_ID;
  const postureLabel = formatPostureLabel(selectedPostureType);
  const recordingStatusLabel = `${displayProfile?.name || "참여자"}님 ${postureLabel} ${activeBodyPart.label} 녹화중`;

  useEffect(() => {
    setSelectedPostureType(session?.postureType === "incorrect" ? "incorrect" : "correct");
  }, [session?.postureType]);

  useEffect(() => {
    const nextSession = {
      ...session,
      postureType: selectedPostureType,
    };
    window.localStorage.setItem(AUTH_COLLECTOR_SESSION_KEY, JSON.stringify(nextSession));
  }, [selectedPostureType, session]);

  useEffect(() => {
    ensureCollectorConsentAtLocation(activeSession).catch(() => {
      // 참여 기록 실패가 촬영 흐름 자체를 막지는 않도록 둡니다.
    });
  }, [activeSession]);

  useEffect(() => {
    let ignore = false;

    findLocalRealSenseCamera().then((camera) => {
      if (!ignore) {
        setLocalRealSenseCamera(camera);
      }
    });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (localRealSenseCamera && !selectedDeviceId) {
      setSelectedDeviceId(REALSENSE_DEVICE_ID);
    }
  }, [localRealSenseCamera, selectedDeviceId]);

  function stopBrowserPreview() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  function stopLocalRealSenseCamera() {
    if (serverPreviewRef.current) {
      serverPreviewRef.current.removeAttribute("src");
    }
    fetch(`${LOCAL_BACKEND_ORIGIN}/api/record/stop`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  }

  async function startLocalRealSensePreview() {
    stopBrowserPreview();
    await fetchJson("/api/preview/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_index: REALSENSE_CAMERA_INDEX }),
    });
    if (serverPreviewRef.current) {
      serverPreviewRef.current.src = `${LOCAL_BACKEND_ORIGIN}/video_feed?t=${Date.now()}`;
    }
  }

  useEffect(() => {
    async function prepareCamera() {
      try {
        setErrorMessage("");
        if (isLocalRealSenseSelected) {
          setStatusMessage("RealSense RGB+Depth 카메라를 연결하고 있습니다.");
          await startLocalRealSensePreview();
          setIsCameraReady(true);
          setStatusMessage("RealSense RGB+Depth 카메라 연결이 완료되었습니다.");
          return;
        }

        setStatusMessage("카메라 권한을 확인하고 있습니다.");

        if (serverPreviewRef.current) {
          serverPreviewRef.current.removeAttribute("src");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : { facingMode: "user" },
          audio: false,
        });

        stopBrowserPreview();

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((device) => device.kind === "videoinput");
        setCameraDevices(videoInputs);

        if (!selectedDeviceId) {
          const activeTrack = stream.getVideoTracks()[0];
          const activeSettings = activeTrack?.getSettings?.() || {};
          if (activeSettings.deviceId) {
            setSelectedDeviceId(activeSettings.deviceId);
          }
        }

        setIsCameraReady(true);
        setStatusMessage("카메라 연결이 완료됐습니다.");
      } catch {
        setIsCameraReady(false);
        setErrorMessage(
          "카메라를 사용할 수 없습니다. 브라우저 권한과 장치 연결 상태를 확인해 주세요.",
        );
        setStatusMessage("");
      }
    }

    prepareCamera();

    return () => {
      stopBrowserPreview();
      if (isLocalRealSenseSelected) {
        stopLocalRealSenseCamera();
      }
    };
  }, [isLocalRealSenseSelected, selectedDeviceId]);

  async function handleStartRealSenseRecording(bodyPartKey = selectedBodyPartKey) {
    try {
      setErrorMessage("");
      setDownloadMessage("");
      const targetBodyPart = getBodyPartOption(bodyPartKey);
      const bodyPartName = REALSENSE_BODY_PART_NAMES[bodyPartKey] || targetBodyPart.label;
      const registerResult = await fetchJson("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: displayProfile?.name || "",
          birth_date: displayProfile?.birthDate || "",
          gender: displayProfile?.gender || "",
          consent: "agree",
          site_key: activeSession?.location || "aim",
        }),
      });

      await fetchJson("/api/record/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participant_id: registerResult.participant_id,
          part_name: bodyPartName,
          camera_index: REALSENSE_CAMERA_INDEX,
          posture_type: selectedPostureType,
          site_key: activeSession?.location || "aim",
        }),
      });

      recordingStartedAtRef.current = Date.now();
      setIsRecording(true);
      setStatusMessage(`${postureLabel} ${targetBodyPart.label} RealSense RGB+Depth 녹화를 시작했습니다.`);
    } catch (error) {
      setIsRecording(false);
      setErrorMessage(error?.message || "RealSense 녹화를 시작할 수 없습니다.");
    }
  }

  async function handleStopRealSenseRecording() {
    if (!isRecording) {
      return;
    }

    setIsSaving(true);
    setStatusMessage("RealSense 녹화 파일을 저장하고 있습니다.");

    try {
      const result = await fetchJson("/api/record/stop", { method: "POST" });
      const recording = result.recording || {};
      const durationMs = Date.now() - recordingStartedAtRef.current;

      await saveCollectionRecording({
        session: activeSession,
        bodyPartKey: selectedBodyPartKey,
        fileName: recording.file_name || buildRecordingFileName(activeSession, selectedBodyPartKey).replace(".webm", ".mp4"),
        mimeType: recording.mime_type || "video/mp4",
        size: recording.size || 0,
        durationMs,
        sourceType: "realsense",
        depth: {
          enabled: Boolean(recording.depth),
          frameCount: recording.depth_frame_count || 0,
          rawFileName: recording.depth_raw_file_name || "",
          indexFileName: recording.depth_index_file_name || "",
          metadataFileName: recording.depth_metadata_file_name || "",
          rawSize: recording.depth_raw_size || 0,
        },
      });

      setDownloadMessage(
        recording.depth
          ? `RealSense 영상과 depth ${recording.depth_frame_count || 0}프레임 저장이 완료되었습니다.`
          : "RealSense 영상 저장이 완료되었습니다.",
      );
      setStatusMessage("다음 촬영을 이어서 진행할 수 있습니다.");
      await startLocalRealSensePreview().catch(() => {});
    } catch (error) {
      setErrorMessage(error?.message || "RealSense 녹화 저장 중 오류가 발생했습니다.");
      setStatusMessage("오류 내용을 확인해 주세요.");
    } finally {
      setIsRecording(false);
      setIsSaving(false);
    }
  }

  async function handleStartRecording(bodyPartKey = selectedBodyPartKey) {
    const targetBodyPart = getBodyPartOption(bodyPartKey);

    if (isLocalRealSenseSelected) {
      await handleStartRealSenseRecording(bodyPartKey);
      return;
    }

    if (!streamRef.current) {
      setErrorMessage("카메라 연결이 완료된 뒤에 녹화를 시작할 수 있습니다.");
      return;
    }

    try {
      setErrorMessage("");
      setDownloadMessage("");
      chunksRef.current = [];

      const mimeType = getSupportedMimeType();
      const mediaRecorder = mimeType
        ? new MediaRecorder(streamRef.current, { mimeType })
        : new MediaRecorder(streamRef.current);

      mediaRecorderRef.current = mediaRecorder;
      recordingStartedAtRef.current = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setIsRecording(false);
        setIsSaving(true);
        setStatusMessage("파일을 저장하고 있습니다.");

        try {
          const actualMimeType = mediaRecorder.mimeType || mimeType || "video/webm";
          const fileName = buildRecordingFileName(activeSession, bodyPartKey);
          const recordedBlob = new Blob(chunksRef.current, { type: actualMimeType });
          const durationMs = Date.now() - recordingStartedAtRef.current;

          downloadBlobFile(recordedBlob, fileName);

          await saveCollectionRecording({
            session: activeSession,
            bodyPartKey,
            fileName,
            mimeType: actualMimeType,
            size: recordedBlob.size,
            durationMs,
          });

          setDownloadMessage("녹화 파일 다운로드와 집계 반영이 완료됐습니다.");
          setStatusMessage("다음 촬영을 이어서 진행할 수 있습니다.");
        } catch (error) {
          setErrorMessage(error?.message || "녹화 저장 중 오류가 발생했습니다.");
          setStatusMessage("오류 내용을 확인해 주세요.");
        } finally {
          setIsSaving(false);
          chunksRef.current = [];
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatusMessage(`${postureLabel} ${targetBodyPart.label} 녹화를 시작했습니다.`);
    } catch {
      setErrorMessage("브라우저에서 녹화를 시작할 수 없습니다.");
    }
  }

  function handleStopRecording() {
    if (isLocalRealSenseSelected) {
      handleStopRealSenseRecording();
      return;
    }

    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
      return;
    }

    mediaRecorderRef.current.stop();
  }

  function openManualBeforeRecording(bodyPartKey) {
    if (isRecording || isSaving) {
      return;
    }

    const targetBodyPart = getBodyPartOption(bodyPartKey);
    setSelectedBodyPartKey(bodyPartKey);
    setManualBodyPartKey(bodyPartKey);
    setManualVideoFailed(false);
    setIsManualOpen(true);
    setErrorMessage("");
    setDownloadMessage("");
    setStatusMessage(`${targetBodyPart.label} 촬영 매뉴얼을 확인해 주세요.`);
  }

  function cancelManual() {
    setIsManualOpen(false);
    setManualVideoFailed(false);
    setManualBodyPartKey("");
    setStatusMessage("촬영할 부위를 선택해 주세요.");
  }

  async function closeManualAndStartRecording() {
    const bodyPartKey = manualBodyPartKey || selectedBodyPartKey;
    setIsManualOpen(false);
    setManualVideoFailed(false);
    setManualBodyPartKey("");
    setSelectedBodyPartKey(bodyPartKey);
    await handleStartRecording(bodyPartKey);
  }

  return (
    <>
    <main className="dashboard">
      <section className="command-board command-board--collection">
        <header className="collection-header">
          <div className="collection-title">
            <p className="info-card__kicker">COLLECTION</p>
            <h1>데이터 수집</h1>
          </div>

          <div className="collection-header__actions">
            <span className="session-expiry">{logoutCountdownLabel}</span>
            {canOpenDashboard ? (
              <button type="button" className="dashboard-secondary-action" onClick={onOpenDashboard}>
                대시보드 전환
              </button>
            ) : null}
            <button type="button" className="dashboard-logout" onClick={onLogout}>
              로그아웃
            </button>
          </div>
        </header>

        <section className="collection-chip-row" aria-label="참여자 정보">
          <span className="collection-chip">수집 위치: {getLocationChipLabel(activeSession?.location)}</span>
          <span className="collection-chip">이름: {displayProfile?.name || "-"}</span>
          <span className="collection-chip">성별: {formatGenderLabel(displayProfile?.gender)}</span>
          <span className="collection-chip">생년월일: {formatBirthDateChip(displayProfile?.birthDate)}</span>
          <span className="collection-chip">유형: {postureLabel}</span>
        </section>

        <section className="collection-grid">
          <article className="collection-panel">
            <div className="collection-panel__header">
              <div>
                <h2>카메라 미리보기</h2>
              </div>

              <label className="collection-device-field collection-device-field--inline">
                <span>카메라 선택</span>
                <select
                  className="auth-input"
                  value={selectedDeviceId}
                  onChange={(event) => setSelectedDeviceId(event.target.value)}
                  disabled={isRecording || isSaving}
                >
                  {cameraDeviceOptions.length === 0 ? (
                    <option value="">기본 카메라</option>
                  ) : (
                    cameraDeviceOptions.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>
                        {device.label || `카메라 ${index + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </div>

            <div className="collection-preview-frame">
              <video
                ref={videoRef}
                className={`collection-preview${isLocalRealSenseSelected ? " collection-preview--hidden" : ""}`}
                autoPlay
                muted
                playsInline
              />
              <img
                ref={serverPreviewRef}
                className={`collection-preview${isLocalRealSenseSelected ? "" : " collection-preview--hidden"}`}
                alt=""
              />
            </div>

            <div className="collection-panel__control-stack">
              <div className="collection-recording-inline" aria-live="polite">
                {isRecording ? (
                  <p className="collection-recording-inline__badge">{recordingStatusLabel}</p>
                ) : (
                  <div className="collection-recording-inline__placeholder" />
                )}
              </div>
            </div>

            <div className="collection-status-stack">
              <p className="collection-status">{statusMessage}</p>
              {errorMessage ? <p className="auth-message auth-message--error">{errorMessage}</p> : null}
              {downloadMessage ? (
                <p className="auth-message auth-message--notice">{downloadMessage}</p>
              ) : null}
            </div>
          </article>

          <aside className="collection-panel collection-panel--actions">
            <div className="collection-panel__section">
              <div className="collection-inline-header">
                <h2>촬영 부위 선택</h2>
                <div className="collection-posture-toggle" aria-label="정답 오답 선택">
                  <button
                    type="button"
                    className={`collection-posture-button${
                      selectedPostureType === "correct" ? " is-active" : ""
                    }`}
                    onClick={() => setSelectedPostureType("correct")}
                    disabled={isRecording || isSaving}
                  >
                    정답
                  </button>
                  <button
                    type="button"
                    className={`collection-posture-button${
                      selectedPostureType === "incorrect" ? " is-active" : ""
                    }`}
                    onClick={() => setSelectedPostureType("incorrect")}
                    disabled={isRecording || isSaving}
                  >
                    오답
                  </button>
                </div>
              </div>
              <div className="collection-body-grid">
                {BODY_PART_OPTIONS.map((bodyPart) => (
                  <button
                    key={bodyPart.key}
                    type="button"
                    className={`collection-body-button${
                      selectedBodyPartKey === bodyPart.key ? " is-active" : ""
                    }`}
                    onClick={() => openManualBeforeRecording(bodyPart.key)}
                    disabled={isRecording || isSaving}
                  >
                    {bodyPart.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="collection-action-box">
              <p className="collection-action-box__label">현재 선택</p>
              <strong className="collection-action-box__value">
                {postureLabel} {activeBodyPart.label}
              </strong>
            </div>

            <div className="collection-action-row">
              <button
                type="button"
                className="auth-submit"
                onClick={() => openManualBeforeRecording(selectedBodyPartKey)}
                disabled={isRecording || isSaving}
              >
                {isSaving ? "저장 중..." : isRecording ? "녹화 중" : `${activeBodyPart.label} 녹화 시작`}
              </button>
              <button
                type="button"
                className="collection-stop-button"
                onClick={handleStopRecording}
                disabled={!isRecording || isSaving}
              >
                녹화 종료 및 저장
              </button>
            </div>
          </aside>
        </section>
      </section>
    </main>

    {isManualOpen ? (
      <div className="collection-manual-modal" role="dialog" aria-modal="true">
        <div className="collection-manual-modal__panel">
          <div className="collection-manual-modal__header">
            <div>
              <p className="info-card__kicker">MANUAL</p>
              <h2>{manualBodyPart.label} 촬영 매뉴얼</h2>
            </div>
            <button
              type="button"
              className="collection-manual-modal__ghost"
              onClick={cancelManual}
              disabled={isRecording || isSaving}
            >
              취소
            </button>
          </div>

          <div className="collection-manual-modal__video-frame">
            {manualVideoFailed ? (
              <div className="collection-manual-modal__fallback">
                <p>매뉴얼 영상을 찾지 못했습니다.</p>
              </div>
            ) : (
              <video
                key={manualVideoSource}
                className="collection-manual-modal__video"
                src={manualVideoSource}
                controls
                autoPlay
                muted
                playsInline
                onError={() => setManualVideoFailed(true)}
              />
            )}
          </div>

          <div className="collection-manual-modal__actions">
            <button
              type="button"
              className="collection-stop-button"
              onClick={cancelManual}
              disabled={isRecording || isSaving}
            >
              취소
            </button>
            <button
              type="button"
              className="auth-submit"
              onClick={closeManualAndStartRecording}
              disabled={isRecording || isSaving}
            >
              {manualVideoFailed ? "매뉴얼 없이 녹화 시작" : "닫고 녹화 시작"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
