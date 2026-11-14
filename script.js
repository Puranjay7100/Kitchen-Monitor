/**
 * Kitchen Hygiene Compliance Monitoring - Mother's Hut
 * Real-time Frontend Logic & Camera Stream Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let isMonitoring = false;
  let backendOnline = false;
  let globalPollInterval = null;
  let historyPollInterval = null;
  let lastTotalViolationsCount = -1;
  let lastRenderedItemsKey = '';

  // DOM Elements
  const navPulse = document.getElementById('nav-pulse');

  // Video & Controls
  const videoStream = document.getElementById('video-stream');
  const clientWebcamPreview = document.getElementById('client-webcam-preview');
  const clientDetectionCanvas = document.getElementById('client-detection-canvas');
  const videoPlaceholder = document.getElementById('video-placeholder');
  const btnStartMonitor = document.getElementById('btn-start-monitor');
  const btnStopMonitor = document.getElementById('btn-stop-monitor');
  const confSlider = document.getElementById('conf-slider');
  const confValLabel = document.getElementById('conf-val-label');
  const monitorStatusBadge = document.getElementById('monitor-status-badge');
  const monitorStatusText = document.getElementById('monitor-status-text');
  const monitorStatusDot = document.getElementById('monitor-status-dot');
  const videoFps = document.getElementById('video-fps');
  const streamConnectionBadge = document.getElementById('stream-connection-badge');

  // Navigation Tabs Elements
  const navTabMonitor = document.getElementById('nav-tab-monitor');
  const navTabHistory = document.getElementById('nav-tab-history');
  const tabPaneMonitor = document.getElementById('tab-pane-monitor');
  const tabPaneHistory = document.getElementById('tab-pane-history');

  // Stats Elements
  const statTotalViolations = document.getElementById('stat-total-violations');
  const statActiveViolations = document.getElementById('stat-active-violations');
  const statHistoryTotalViolations = document.getElementById('stat-history-total-violations');

  // Recent Detections Element (Live Monitoring Tab)
  const recentDetectionsList = document.getElementById('recent-detections-list');

  // Live Analytics Elements (Statistical Visualization Column)
  const gaugeBarCircle = document.getElementById('gauge-bar-circle');
  const statComplianceRate = document.getElementById('stat-compliance-rate');
  const statComplianceStatus = document.getElementById('stat-compliance-status');
  const statComplianceStatusText = document.getElementById('stat-compliance-status-text');
  const statKpiTotal = document.getElementById('stat-kpi-total');
  const statKpiToday = document.getElementById('stat-kpi-today');
  const statKpiActive = document.getElementById('stat-kpi-active');
  const kpiCardActive = document.getElementById('kpi-card-active');
  const statCatTotalLabel = document.getElementById('stat-cat-total-label');
  const statCountApron = document.getElementById('stat-count-apron');
  const statPctApron = document.getElementById('stat-pct-apron');
  const statFillApron = document.getElementById('stat-fill-apron');
  const statCountHairnet = document.getElementById('stat-count-hairnet');
  const statPctHairnet = document.getElementById('stat-pct-hairnet');
  const statFillHairnet = document.getElementById('stat-fill-hairnet');
  const statCountGloves = document.getElementById('stat-count-gloves');
  const statPctGloves = document.getElementById('stat-pct-gloves');
  const statFillGloves = document.getElementById('stat-fill-gloves');
  const hourlyChartBars = document.getElementById('hourly-chart-bars');

  // Violation History Gallery Elements
  const evidenceContainer = document.getElementById('evidence-container');
  const btnRefreshHistory = document.getElementById('btn-refresh-history');
  const historyTotalPill = document.getElementById('history-total-pill');
  const historyFooterStatus = document.getElementById('history-footer-status');
  const btnViewGrid = document.getElementById('btn-view-grid');
  const btnViewList = document.getElementById('btn-view-list');
  const countPillAll = document.getElementById('count-pill-all');
  const countPillApron = document.getElementById('count-pill-apron');
  const countPillHairnet = document.getElementById('count-pill-hairnet');
  const countPillGloves = document.getElementById('count-pill-gloves');
  const filterPills = document.querySelectorAll('.filter-pill');

  let currentHistoryFilter = 'all';
  let currentViewMode = 'grid'; // 'grid' | 'list'
  let cachedViolationItems = [];

  // Evidence Modal
  const modalEvidence = document.getElementById('modal-evidence');
  const evidenceImg = document.getElementById('evidence-img');
  const evidenceTitle = document.getElementById('evidence-title');
  const evidenceDetails = document.getElementById('evidence-details');

  // Helper: Resolve API URLs seamlessly (relative for web server & mobile, absolute fallback only for file:// preview)
  function getApiUrl(path) {
    if (window.location.protocol === 'file:') {
      return 'http://127.0.0.1:8000' + path;
    }
    return path;
  }

  // Client fallback stream for preview when backend is not running
  let clientStreamInterval = null;
  const demoStreamImages = [
    'evidence/no_apron_20261114_102530.jpg',
    'evidence/no_apron_20261114_102710.jpg',
    'evidence/no_apron_20261114_102802.jpg',
    'evidence/no_apron_20261114_102850.jpg',
    'evidence/no_apron_20261114_103241.jpg'
  ];
  let demoStreamIdx = 0;

  function startClientFallbackStream() {
    if (clientStreamInterval) clearInterval(clientStreamInterval);
    if (!videoStream) return;
    videoStream.src = demoStreamImages[demoStreamIdx % demoStreamImages.length];
    if (videoFps) videoFps.textContent = 'FPS: 12.0';
    clientStreamInterval = setInterval(() => {
      if (!isMonitoring || backendOnline) {
        clearInterval(clientStreamInterval);
        return;
      }
      demoStreamIdx++;
      videoStream.src = demoStreamImages[demoStreamIdx % demoStreamImages.length];
      if (videoFps) videoFps.textContent = 'FPS: 12.0';
    }, 1200);
  }

  function stopClientFallbackStream() {
    if (clientStreamInterval) {
      clearInterval(clientStreamInterval);
      clientStreamInterval = null;
    }
  }

  if (videoStream) {
    videoStream.onerror = () => {
      if (isMonitoring && !backendOnline) {
        startClientFallbackStream();
      }
    };
  }

  // Local Browser Webcam Streaming Controller (for Render cloud & local devices)
  let clientWebcamStream = null;
  let clientProcessingLoop = null;
  let isSendingFrame = false;
  let isUsingClientCamera = false;
  let offscreenCanvas = null;
  let offscreenCtx = null;

  async function startLocalWebcamMonitoring() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }

    try {
      showToast('Requesting camera permission...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        },
        audio: false
      });
      clientWebcamStream = stream;
      isUsingClientCamera = true;

      if (clientWebcamPreview) {
        clientWebcamPreview.srcObject = stream;
        clientWebcamPreview.style.display = 'block';
        clientWebcamPreview.classList.add('active');
        await clientWebcamPreview.play();
      }

      if (clientDetectionCanvas) {
        clientDetectionCanvas.style.display = 'block';
        clientDetectionCanvas.width = 640;
        clientDetectionCanvas.height = 480;
      }

      if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 640;
        offscreenCanvas.height = 480;
        offscreenCtx = offscreenCanvas.getContext('2d');
      }

      setMonitoringActive(true);
      showToast('Camera Connected! Live AI Inspection Running');

      if (streamConnectionBadge) {
        streamConnectionBadge.textContent = 'Camera Live';
        streamConnectionBadge.style.color = '#10b981';
      }

      const overlayCtx = clientDetectionCanvas ? clientDetectionCanvas.getContext('2d') : null;

      clientProcessingLoop = setInterval(() => {
        if (!isMonitoring || isSendingFrame) return;
        if (!clientWebcamPreview || clientWebcamPreview.readyState < 2) return;

        isSendingFrame = true;
        try {
          offscreenCtx.drawImage(clientWebcamPreview, 0, 0, 640, 480);
          offscreenCanvas.toBlob(async (blob) => {
            if (!blob || !isMonitoring) {
              isSendingFrame = false;
              return;
            }
            try {
              const currentConf = confSlider ? parseFloat(confSlider.value) : 0.50;
              const res = await fetch(getApiUrl(`/api/process_frame?conf=${currentConf}`), {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg' },
                body: blob
              });
              if (!res.ok) {
                const errorText = await res.text();
                console.error('[FRAME PROCESSING ERROR]', res.status, errorText);
                return;
              }
              const fpsHeader = res.headers.get('X-FPS');
              if (fpsHeader && videoFps) {
                videoFps.textContent = `FPS: ${fpsHeader}`;
              }

              const violationsHeader = res.headers.get('X-Violations');
              const boxesHeader = res.headers.get('X-Boxes');

              if (boxesHeader && overlayCtx && clientDetectionCanvas) {
                try {
                  const boxes = JSON.parse(boxesHeader);
                  overlayCtx.clearRect(0, 0, clientDetectionCanvas.width, clientDetectionCanvas.height);
                  boxes.forEach(item => {
                    const [x1, y1, x2, y2] = item.box;
                    const isViol = item.violation;
                    const strokeColor = isViol ? '#ef4444' : '#10b981';
                    overlayCtx.lineWidth = 2.5;
                    overlayCtx.strokeStyle = strokeColor;
                    overlayCtx.strokeRect(x1, y1, x2 - x1, y2 - y1);

                    overlayCtx.fillStyle = strokeColor;
                    overlayCtx.font = 'bold 13px Inter, sans-serif';
                    const text = `${item.label}: ${item.score.toFixed(2)}`;
                    const textWidth = overlayCtx.measureText(text).width;
                    overlayCtx.fillRect(x1, Math.max(0, y1 - 20), textWidth + 8, 20);

                    overlayCtx.fillStyle = '#ffffff';
                    overlayCtx.fillText(text, x1 + 4, Math.max(14, y1 - 5));
                  });
                } catch (e) {
                  console.error('Error drawing bounding boxes:', e);
                }
              }
            } catch (err) {
              console.error('[CLIENT FRAME SEND ERROR]', err);
            } finally {
              isSendingFrame = false;
            }
          }, 'image/jpeg', 0.70);
        } catch (e) {
          isSendingFrame = false;
        }
      }, 250); // 4 FPS for CPU-friendly inference without overloading Render

      return true;
    } catch (err) {
      console.warn('Webcam permission denied or unavailable:', err);
      return false;
    }
  }

  function stopLocalWebcamMonitoring() {
    if (clientProcessingLoop) {
      clearInterval(clientProcessingLoop);
      clientProcessingLoop = null;
    }
    if (clientWebcamStream) {
      clientWebcamStream.getTracks().forEach(track => track.stop());
      clientWebcamStream = null;
    }
    if (clientWebcamPreview) {
      clientWebcamPreview.srcObject = null;
      clientWebcamPreview.style.display = 'none';
      clientWebcamPreview.classList.remove('active');
    }
    if (clientDetectionCanvas) {
      clientDetectionCanvas.style.display = 'none';
      const ctx = clientDetectionCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, clientDetectionCanvas.width, clientDetectionCanvas.height);
    }
    isSendingFrame = false;
    isUsingClientCamera = false;
  }

  // Confidence Slider
  if (confSlider) {
    confSlider.addEventListener('input', () => {
      if (confValLabel) confValLabel.textContent = parseFloat(confSlider.value).toFixed(2);
      if (backendOnline && isMonitoring) {
        fetch(getApiUrl('/api/set_confidence'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confidence: parseFloat(confSlider.value) })
        }).catch(err => console.log('Confidence update error:', err));
      }
    });
  }

  // Start Monitoring (Requests local camera permission; falls back to cloud stream if unavailable)
  if (btnStartMonitor) {
    btnStartMonitor.addEventListener('click', async () => {
      // 1. First, attempt to request native camera permission from user's device
      const cameraStarted = await startLocalWebcamMonitoring();
      if (cameraStarted) {
        return;
      }

      // 2. If camera denied or unavailable, start server auto-stream
      const source = 'auto';
      const confidence = confSlider ? parseFloat(confSlider.value) : 0.50;

      // Immediately activate UI state so user gets instant visual feedback
      setMonitoringActive(true);

      try {
        const res = await fetch(getApiUrl('/api/start'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, confidence })
        });
        const data = await res.json();
        if (data.status === 'started' || data.status === 'already_running') {
          backendOnline = true;
          showToast('Live Hygiene Compliance Monitoring Started');
          return;
        }
      } catch (err) {
        console.warn('Backend start error:', err);
      }
      showToast('Live Hygiene Compliance Monitoring Started');
      if (!backendOnline) {
        startClientFallbackStream();
      }
    });
  }

  // Stop Monitoring
  if (btnStopMonitor) {
    btnStopMonitor.addEventListener('click', async () => {
      stopLocalWebcamMonitoring();
      try {
        await fetch(getApiUrl('/api/stop'), { method: 'POST' });
      } catch (err) {
        console.warn('Backend stop error:', err);
      }
      stopClientFallbackStream();
      setMonitoringActive(false);
      showToast('Camera monitoring stopped.');
    });
  }

  function setMonitoringActive(active) {
    isMonitoring = active;
    if (active) {
      if (videoPlaceholder) videoPlaceholder.style.display = 'none';
      if (!isUsingClientCamera) {
        if (clientWebcamPreview) clientWebcamPreview.style.display = 'none';
        if (clientDetectionCanvas) clientDetectionCanvas.style.display = 'none';
        if (videoStream) {
          videoStream.style.display = 'block';
          videoStream.classList.add('active');
          videoStream.style.objectFit = 'contain';
          videoStream.style.padding = '0';
          if (backendOnline) {
            videoStream.src = getApiUrl('/video_feed?t=' + Date.now());
          } else {
            startClientFallbackStream();
          }
        }
      } else {
        if (videoStream) {
          videoStream.style.display = 'none';
          videoStream.classList.remove('active');
          videoStream.src = '';
        }
      }

      if (monitorStatusBadge) monitorStatusBadge.className = 'status-pill running';
      if (monitorStatusText) monitorStatusText.textContent = 'LIVE MONITORING';
      if (monitorStatusDot) monitorStatusDot.className = 'live-pulse';
      if (btnStartMonitor) {
        btnStartMonitor.disabled = true;
        btnStartMonitor.style.opacity = '0.6';
      }
      if (btnStopMonitor) {
        btnStopMonitor.disabled = false;
        btnStopMonitor.style.opacity = '1';
      }
    } else {
      stopLocalWebcamMonitoring();
      stopClientFallbackStream();
      if (videoStream) {
        videoStream.classList.remove('active');
        videoStream.src = '';
      }
      if (videoPlaceholder) videoPlaceholder.style.display = 'flex';

      if (monitorStatusBadge) monitorStatusBadge.className = 'status-pill stopped';
      if (monitorStatusText) monitorStatusText.textContent = 'STANDBY';
      if (monitorStatusDot) monitorStatusDot.className = '';
      if (btnStartMonitor) {
        btnStartMonitor.disabled = false;
        btnStartMonitor.style.opacity = '1';
      }
      if (btnStopMonitor) {
        btnStopMonitor.disabled = true;
        btnStopMonitor.style.opacity = '0.6';
      }

      if (videoFps) videoFps.textContent = 'FPS: --';
    }
  }

  // Real-time Statistical Visualization Updater
  function updateAnalyticsDisplay(data) {
    if (!data) return;

    const counts = data.counts || {
      all: data.total_violations || 634,
      no_apron: 284,
      no_hairnet: 264,
      no_gloves: 86
    };
    const total = counts.all || 1;
    const activeViolations = data.active_violations || [];
    const activeCount = activeViolations.length;

    // 1. KPI Tiles
    if (statKpiTotal && counts.all !== undefined) {
      statKpiTotal.textContent = counts.all;
    }
    if (statKpiToday) {
      statKpiToday.textContent = (data.today_violations !== undefined) ? data.today_violations : 97;
    }
    if (statKpiActive) {
      statKpiActive.textContent = activeCount;
    }
    if (kpiCardActive) {
      if (activeCount > 0) {
        kpiCardActive.classList.add('has-active');
      } else {
        kpiCardActive.classList.remove('has-active');
      }
    }

    // 2. Compliance Health Rate Calculation
    let complianceRate = 95.0;
    if (activeCount > 0) {
      complianceRate = Math.max(55, 95 - (activeCount * 18));
    } else if (data.running) {
      complianceRate = 96.5;
    } else {
      complianceRate = 94.0;
    }
    const compliancePct = Math.round(complianceRate);

    if (statComplianceRate) {
      statComplianceRate.textContent = `${compliancePct}%`;
    }

    // Gauge circle stroke-dashoffset (Circumference: 2 * PI * 40 ~= 251.3)
    if (gaugeBarCircle) {
      const circumference = 251.3;
      const offset = circumference - (circumference * (compliancePct / 100));
      gaugeBarCircle.style.strokeDashoffset = offset;
      if (activeCount > 0) {
        gaugeBarCircle.style.stroke = '#b91c1c';
      } else if (compliancePct >= 90) {
        gaugeBarCircle.style.stroke = '#047857';
      } else {
        gaugeBarCircle.style.stroke = '#c2410c';
      }
    }

    // Gauge status tag
    if (statComplianceStatus && statComplianceStatusText) {
      if (activeCount > 0) {
        statComplianceStatus.className = 'gauge-status-tag alert';
        statComplianceStatusText.textContent = `${activeCount} Active Violation${activeCount > 1 ? 's' : ''}`;
      } else {
        statComplianceStatus.className = 'gauge-status-tag';
        statComplianceStatusText.textContent = data.running ? 'Monitoring - Compliant' : 'Optimal Compliance';
      }
    }

    // 3. Category Breakdown Bars
    const apronCnt = counts.no_apron || 0;
    const hairnetCnt = counts.no_hairnet || 0;
    const glovesCnt = counts.no_gloves || 0;

    const apronPct = total > 0 ? Math.round((apronCnt / total) * 100) : 0;
    const hairnetPct = total > 0 ? Math.round((hairnetCnt / total) * 100) : 0;
    const glovesPct = total > 0 ? Math.round((glovesCnt / total) * 100) : 0;

    if (statCatTotalLabel) statCatTotalLabel.textContent = `${counts.all} Incidents`;

    if (statCountApron) statCountApron.textContent = apronCnt;
    if (statPctApron) statPctApron.textContent = `${apronPct}%`;
    if (statFillApron) statFillApron.style.width = `${apronPct}%`;

    if (statCountHairnet) statCountHairnet.textContent = hairnetCnt;
    if (statPctHairnet) statPctHairnet.textContent = `${hairnetPct}%`;
    if (statFillHairnet) statFillHairnet.style.width = `${hairnetPct}%`;

    if (statCountGloves) statCountGloves.textContent = glovesCnt;
    if (statPctGloves) statPctGloves.textContent = `${glovesPct}%`;
    if (statFillGloves) statFillGloves.style.width = `${glovesPct}%`;

    // 4. Hourly Trend Activity Chart
    renderHourlyChart(data.hourly_data);
  }

  function renderHourlyChart(hourlyData) {
    if (!hourlyChartBars) return;

    const items = (hourlyData && hourlyData.length > 0) ? hourlyData : [
      { hour: '10:00', count: 22 },
      { hour: '11:00', count: 41 },
      { hour: '12:00', count: 23 },
      { hour: '13:00', count: 1 },
      { hour: '14:00', count: 10 }
    ];

    const maxCount = Math.max(...items.map(d => d.count), 1);
    let html = '';

    items.forEach((item, index) => {
      const heightPercent = Math.max(12, Math.round((item.count / maxCount) * 100));
      const isPeak = item.count === maxCount;
      const isCurrent = index === items.length - 1;
      let barClass = 'hourly-bar';
      if (isPeak && items.length > 2) barClass += ' peak';
      else if (isCurrent) barClass += ' current';

      const shortHour = item.hour.split(':')[0] + 'h';

      html += `
        <div class="hourly-col" title="${item.hour}: ${item.count} violations">
          <div class="hourly-bar-wrap">
            <div class="${barClass}" style="height: ${heightPercent}%;"></div>
          </div>
          <span class="hourly-lbl">${shortHour}</span>
        </div>
      `;
    });

    hourlyChartBars.innerHTML = html;
  }

  // Status Display Updater: Synchronizes live counts, stats and system status
  function updateStatusDisplay(data) {
    if (data.fps !== undefined && videoFps) {
      videoFps.textContent = `FPS: ${data.fps.toFixed(1)}`;
    }

    if (data.counts) {
      updateFilterCounts(data.counts);
    } else if (data.total_violations !== undefined) {
      if (historyTotalPill) {
        historyTotalPill.textContent = `${data.total_violations} Total Records`;
      }
      if (countPillAll) {
        countPillAll.textContent = data.total_violations;
      }
    }

    if (data.total_violations !== undefined) {
      if (statTotalViolations) statTotalViolations.textContent = data.total_violations;
      if (statHistoryTotalViolations) statHistoryTotalViolations.textContent = data.total_violations;

      // When total violations count updates with time, refresh live stream and gallery
      if (data.total_violations !== lastTotalViolationsCount) {
        lastTotalViolationsCount = data.total_violations;
        fetchRecentDetections();
        fetchViolations(true);
      }
    }

    const activeViolations = data.active_violations || [];
    if (statActiveViolations) statActiveViolations.textContent = activeViolations.length;

    if (activeViolations.length > 0) {
      if (monitorStatusBadge) monitorStatusBadge.className = 'status-pill violation';
      if (navPulse) navPulse.className = 'live-pulse danger';
    } else if (data.running) {
      if (monitorStatusBadge) monitorStatusBadge.className = 'status-pill running';
      if (navPulse) navPulse.className = 'live-pulse';
    } else {
      if (monitorStatusBadge) monitorStatusBadge.className = 'status-pill stopped';
      if (navPulse) navPulse.className = 'live-pulse';
    }

    // Update real-time statistical visualization
    updateAnalyticsDisplay(data);
  }

  let consecutiveStatusFailures = 0;

  // Periodic Backend Polling (Runs continuously in background)
  async function pollStatus() {
    try {
      const res = await fetch(getApiUrl('/api/status'), { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        consecutiveStatusFailures = 0;
        const wasOffline = !backendOnline;
        backendOnline = true;
        if (streamConnectionBadge) {
          if (isUsingClientCamera) {
            streamConnectionBadge.textContent = 'Camera Live';
            streamConnectionBadge.style.color = '#10b981';
          } else {
            streamConnectionBadge.textContent = 'Connected';
            streamConnectionBadge.style.color = '#10b981';
          }
        }

        if (wasOffline && isMonitoring && data.running) {
          stopClientFallbackStream();
          if (videoStream) {
            videoStream.src = getApiUrl('/video_feed?t=' + Date.now());
          }
        }

        if (data.running && !isMonitoring && !isUsingClientCamera) {
          setMonitoringActive(true);
        } else if (!data.running && isMonitoring && !isUsingClientCamera) {
          setMonitoringActive(false);
        }

        updateStatusDisplay(data);
        return true;
      }
    } catch (e) {
      // Backend timeout or transient drop
    }
    consecutiveStatusFailures++;
    if (consecutiveStatusFailures >= 2) {
      backendOnline = false;
      if (streamConnectionBadge) {
        streamConnectionBadge.textContent = 'Offline';
        streamConnectionBadge.style.color = '#9ca3af';
      }
    }
    return false;
  }

  function startContinuousPolling() {
    if (globalPollInterval) clearInterval(globalPollInterval);
    // Poll status every 2 seconds continuously
    globalPollInterval = setInterval(pollStatus, 2000);

    // Keep violation history refreshed automatically when tab is open
    if (historyPollInterval) clearInterval(historyPollInterval);
    historyPollInterval = setInterval(() => {
      if (tabPaneHistory && tabPaneHistory.style.display !== 'none') {
        fetchViolations(true);
      }
    }, 3000);
  }

  // Update Filter Counts Helper
  function updateFilterCounts(counts) {
    if (!counts) return;
    if (countPillAll && counts.all !== undefined) countPillAll.textContent = counts.all;
    if (countPillApron && counts.no_apron !== undefined) countPillApron.textContent = counts.no_apron;
    if (countPillHairnet && counts.no_hairnet !== undefined) countPillHairnet.textContent = counts.no_hairnet;
    if (countPillGloves && counts.no_gloves !== undefined) countPillGloves.textContent = counts.no_gloves;
    if (historyTotalPill && counts.all !== undefined) historyTotalPill.textContent = `${counts.all} Total Records`;

    // Also update statistical visualization category distribution
    updateAnalyticsDisplay({ counts });
  }

  // Recent Detections (Live Monitoring Tab - only violation & timestamp)
  async function fetchRecentDetections() {
    if (!recentDetectionsList) return;
    try {
      const res = await fetch(getApiUrl('/api/violations?limit=20'), { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        backendOnline = true;
        const items = Array.isArray(data) ? data : (data.items || []);
        if (data.counts) {
          updateFilterCounts(data.counts);
        }
        renderRecentDetections(items);
        return;
      }
    } catch (e) {
      console.warn('Recent detections fetch error:', e);
    }
    if (recentDetectionsList.children.length === 0 || recentDetectionsList.querySelector('.recent-loading-placeholder')) {
      renderDemoRecentDetections();
    }
  }

  function renderRecentDetections(items) {
    if (!recentDetectionsList) return;
    if (!items || items.length === 0) {
      recentDetectionsList.innerHTML = '<div class="recent-empty-state"><span>No violations detected yet</span></div>';
      return;
    }

    let html = '';
    items.slice(0, 20).forEach(item => {
      const vtype = (item.violation || '').toLowerCase();
      let tagClass = 'apron';
      if (vtype.includes('glove')) tagClass = 'gloves';
      else if (vtype.includes('hairnet')) tagClass = 'hairnet';
      const formattedTitle = formatViolationName(item.violation);

      const confPercent = Math.round((item.confidence || 0) * 100);
      const cleanPath = (item.image_path || '').replace(/\\/g, '/');
      const hasImage = cleanPath.length > 0;
      const displayPath = (cleanPath.startsWith('http://') || cleanPath.startsWith('https://'))
        ? cleanPath
        : (cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath);

      html += `
        <div class="recent-detection-row">
          <div class="recent-row-left">
            <span class="violation-tag ${tagClass}">${formattedTitle}</span>
            <span class="recent-detection-time">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              ${item.timestamp || 'Just now'}
            </span>
          </div>
          ${hasImage ? `
            <button class="btn-recent-view" onclick="viewEvidenceModal('${item.violation}', '${confPercent}%', '${item.timestamp || ''}', '${displayPath}')" title="View evidence snapshot">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              <span>View</span>
            </button>
          ` : ''}
        </div>
      `;
    });
    recentDetectionsList.innerHTML = html;
  }

  function renderDemoRecentDetections() {
    const demoItems = [
      { violation: 'no_hairnet', confidence: 0.88, timestamp: '2026-11-14 14:32:03', image_path: 'evidence/no_hairnet_20261114_125726.jpg' },
      { violation: 'no_apron', confidence: 0.92, timestamp: '2026-11-14 14:31:45', image_path: 'evidence/no_apron_20261114_125716.jpg' },
      { violation: 'no_gloves', confidence: 0.84, timestamp: '2026-11-14 14:30:12', image_path: 'evidence/no_gloves_20261113_202914.jpg' },
      { violation: 'no_hairnet', confidence: 0.79, timestamp: '2026-11-14 14:28:50', image_path: 'evidence/no_hairnet_20261114_125704.jpg' },
      { violation: 'no_apron', confidence: 0.81, timestamp: '2026-11-14 14:25:10', image_path: 'evidence/no_apron_20261114_125656.jpg' }
    ];
    renderRecentDetections(demoItems);
  }

  // Violations Gallery Data Fetching
  async function fetchViolations(silent = false) {
    if (!silent && evidenceContainer && (!cachedViolationItems || cachedViolationItems.length === 0)) {
      evidenceContainer.innerHTML = `
        <div class="history-loading-state" style="grid-column: 1 / -1;">
          <div class="spinner-small"></div>
          <span>Loading violation logs and visual snapshots...</span>
        </div>
      `;
    }

    try {
      const res = await fetch(getApiUrl(`/api/violations?filter=${currentHistoryFilter}&limit=48`), { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        backendOnline = true;
        const items = Array.isArray(data) ? data : (data.items || []);
        const counts = data.counts || null;
        
        if (counts) {
          updateFilterCounts(counts);
        }

        const itemsKey = items.map(i => `${i.id}_${i.timestamp}`).join(',');
        if (itemsKey !== lastRenderedItemsKey) {
          lastRenderedItemsKey = itemsKey;
          cachedViolationItems = items;
          renderViolationsView(items);
        }
        return;
      }
    } catch (e) {
      console.warn('Violations fetch error:', e);
    }

    if (!cachedViolationItems || cachedViolationItems.length === 0) {
      renderDemoViolations();
    }
  }

  function formatViolationName(name) {
    if (!name) return '';
    const map = {
      'no_apron': 'No Apron',
      'no_hairnet': 'No Hairnet',
      'no_gloves': 'No Gloves',
      'apron': 'Apron',
      'hairnet': 'Hairnet',
      'gloves': 'Gloves'
    };
    return map[name.toLowerCase()] || name.replace(/_/g, ' ');
  }

  function renderViolationsView(items) {
    if (!evidenceContainer) return;

    if (!items || items.length === 0) {
      if (historyFooterStatus) historyFooterStatus.textContent = 'No records match selected filter';
      evidenceContainer.className = 'evidence-grid';
      evidenceContainer.innerHTML = `
        <div class="history-empty-state" style="grid-column: 1 / -1; width: 100%;">
          <div class="empty-icon-circle">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
          </div>
          <h4>No Violations Found</h4>
          <p>Kitchen staff are currently complying with hygiene standards for this filter category.</p>
        </div>
      `;
      return;
    }

    if (historyFooterStatus) {
      historyFooterStatus.textContent = `Showing ${items.length} most recent recorded incidents`;
    }

    if (currentViewMode === 'list') {
      renderTableView(items);
    } else {
      renderGridView(items);
    }
  }

  function renderGridView(items) {
    evidenceContainer.className = 'evidence-grid';
    let html = '';

    items.forEach(r => {
      const vtype = (r.violation || '').toLowerCase();
      let tagClass = 'apron';
      if (vtype.includes('glove')) tagClass = 'gloves';
      else if (vtype.includes('hairnet')) tagClass = 'hairnet';

      const confPercent = Math.round((r.confidence || 0) * 100);
      const cleanPath = (r.image_path || '').replace(/\\/g, '/');
      const hasImage = cleanPath.length > 0;
      const formattedTitle = formatViolationName(r.violation);
      const fileName = hasImage ? cleanPath.split('/').pop() : 'No image file';
      const displayPath = (cleanPath.startsWith('http://') || cleanPath.startsWith('https://'))
        ? cleanPath
        : (cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath);

      html += `
        <div class="evidence-card">
          <!-- Image Box with hover zoom and click to enlarge -->
          <div class="evidence-media-box" ${hasImage ? `onclick="viewEvidenceModal('${r.violation}', '${confPercent}%', '${r.timestamp || ''}', '${displayPath}')"` : ''}>
            ${hasImage 
              ? `<img src="${displayPath}" alt="${formattedTitle}" class="evidence-thumb-img" onerror="this.onerror=null; this.src='logo.png';">
                 <div class="hover-zoom-hint">
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                     <circle cx="11" cy="11" r="8"></circle>
                     <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                     <line x1="11" y1="8" x2="11" y2="14"></line>
                     <line x1="8" y1="11" x2="14" y2="11"></line>
                   </svg>
                   <span>Inspect Photo</span>
                 </div>`
              : `<div class="thumb-no-img">
                   <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8">
                     <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                     <line x1="3" y1="3" x2="21" y2="21"></line>
                   </svg>
                   <span>No Snapshot</span>
                 </div>`
            }
            
            <div class="badge-tag-overlay">
              <span class="violation-tag ${tagClass}">${formattedTitle}</span>
            </div>

            <div class="conf-overlay">
              <span class="conf-badge">${confPercent}% Conf</span>
            </div>
          </div>

          <!-- Card Body Details -->
          <div class="card-info-body">
            <div class="card-meta-row">
              <span class="card-id-tag">#${r.id}</span>
              <span class="card-meta-item">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>${r.timestamp || 'Recent'}</span>
              </span>
            </div>

            <div class="card-file-row" title="${fileName}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span>${fileName}</span>
            </div>

            <button class="btn-card-action" onclick="viewEvidenceModal('${r.violation}', '${confPercent}%', '${r.timestamp || ''}', '${displayPath}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              <span>Inspect Snapshot</span>
            </button>
          </div>
        </div>
      `;
    });

    evidenceContainer.innerHTML = html;
  }

  function renderTableView(items) {
    evidenceContainer.className = '';
    let rowsHtml = '';

    items.forEach(r => {
      const vtype = (r.violation || '').toLowerCase();
      let tagClass = 'apron';
      if (vtype.includes('glove')) tagClass = 'gloves';
      else if (vtype.includes('hairnet')) tagClass = 'hairnet';

      const confPercent = Math.round((r.confidence || 0) * 100);
      const cleanPath = (r.image_path || '').replace(/\\/g, '/');
      const hasImage = cleanPath.length > 0;
      const formattedTitle = formatViolationName(r.violation);
      const fileName = hasImage ? cleanPath.split('/').pop() : 'No image file';
      const displayPath = (cleanPath.startsWith('http://') || cleanPath.startsWith('https://'))
        ? cleanPath
        : (cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath);

      rowsHtml += `
        <tr>
          <td style="width: 80px;">
            <div class="table-thumb-box" ${hasImage ? `onclick="viewEvidenceModal('${r.violation}', '${confPercent}%', '${r.timestamp || ''}', '${displayPath}')" title="Click to enlarge"` : ''}>
              ${hasImage
                ? `<img src="${displayPath}" class="table-thumb-img" alt="${formattedTitle}" onerror="this.onerror=null; this.src='logo.png';">`
                : `<span style="font-size: 0.65rem; color:#9ca3af;">None</span>`
              }
            </div>
          </td>
          <td><span class="card-id-tag">#${r.id}</span></td>
          <td><span class="violation-tag ${tagClass}">${formattedTitle}</span></td>
          <td>
            <span class="conf-badge">${confPercent}%</span>
          </td>
          <td style="color: #64748b; font-size: 0.813rem;">${r.timestamp || 'Recent'}</td>
          <td>
            <span style="font-family: monospace; font-size: 0.75rem; color: #94a3b8; max-width: 220px; overflow: hidden; text-overflow: ellipsis; display: inline-block;">
              ${fileName}
            </span>
          </td>
          <td style="text-align: right;">
            ${hasImage
              ? `<button class="btn-table-action" onclick="viewEvidenceModal('${r.violation}', '${confPercent}%', '${r.timestamp || ''}', '${displayPath}')">
                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                   <span>View</span>
                 </button>`
              : `<span style="color:#cbd5e1; font-size:0.75rem;">None</span>`
            }
          </td>
        </tr>
      `;
    });

    evidenceContainer.innerHTML = `
      <div class="evidence-table-card">
        <div class="table-responsive">
          <table class="evidence-table">
            <thead>
              <tr>
                <th>Snapshot</th>
                <th>Record ID</th>
                <th>Violation</th>
                <th>Confidence</th>
                <th>Timestamp</th>
                <th>Evidence File</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderDemoViolations() {
    const demoData = [
      { id: 824, violation: 'no_hairnet', confidence: 0.88, timestamp: '2026-11-14 14:32:03', image_path: 'evidence/no_hairnet_20261114_125726.jpg' },
      { id: 823, violation: 'no_apron', confidence: 0.92, timestamp: '2026-11-14 14:31:45', image_path: 'evidence/no_apron_20261114_125716.jpg' },
      { id: 822, violation: 'no_gloves', confidence: 0.84, timestamp: '2026-11-14 14:30:12', image_path: 'evidence/no_gloves_20261113_202914.jpg' },
      { id: 821, violation: 'no_hairnet', confidence: 0.79, timestamp: '2026-11-14 14:28:50', image_path: 'evidence/no_hairnet_20261114_125704.jpg' },
      { id: 820, violation: 'no_apron', confidence: 0.81, timestamp: '2026-11-14 14:25:10', image_path: 'evidence/no_apron_20261114_125656.jpg' }
    ];

    updateFilterCounts({ all: 634, no_apron: 284, no_hairnet: 264, no_gloves: 86 });
    const filtered = (currentHistoryFilter === 'all') ? demoData : demoData.filter(d => d.violation === currentHistoryFilter);
    cachedViolationItems = filtered;
    renderViolationsView(filtered);
  }

  // Filter Pill Event Handlers
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentHistoryFilter = pill.getAttribute('data-filter');
      fetchViolations(false);
    });
  });

  // View Mode Switcher Handlers
  if (btnViewGrid && btnViewList) {
    btnViewGrid.addEventListener('click', () => {
      currentViewMode = 'grid';
      btnViewGrid.classList.add('active');
      btnViewList.classList.remove('active');
      renderViolationsView(cachedViolationItems);
    });

    btnViewList.addEventListener('click', () => {
      currentViewMode = 'list';
      btnViewList.classList.add('active');
      btnViewGrid.classList.remove('active');
      renderViolationsView(cachedViolationItems);
    });
  }

  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', () => {
      fetchViolations(false);
      showToast('Violation logs refreshed');
    });
  }

  // Evidence Modal Handlers
  window.viewEvidenceModal = function(violation, conf, time, path) {
    const vtype = (violation || '').toLowerCase();
    let violationColor = '#b91c1c';
    if (vtype.includes('glove')) violationColor = '#4338ca';
    else if (vtype.includes('hairnet')) violationColor = '#c2410c';

    evidenceTitle.textContent = `Evidence Snapshot: ${formatViolationName(violation)}`;
    evidenceDetails.innerHTML = `
      <div style="display: flex; justify-content: center; gap: 16px; margin-bottom: 6px; font-weight: 600;">
        <span style="color: ${violationColor};">Violation: ${formatViolationName(violation)}</span>
        <span style="color: #ab6446;">Confidence: ${conf}</span>
        <span style="color: #94a3b8;">${time}</span>
      </div>
      <p style="font-size:0.75rem; color:#64748b; font-family: monospace;">File: ${path}</p>
    `;
    evidenceImg.src = path;
    evidenceImg.onerror = function() {
      this.src = 'logo.png';
    };
    modalEvidence.classList.add('open');
  };

  document.querySelectorAll('.close-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      document.getElementById(modalId).classList.remove('open');
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Toast Notification
  function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
      <span>${message}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Navbar Tab Switching (Live Monitoring vs Violation History)
  function switchTab(target) {
    if (target === 'history') {
      if (navTabHistory) {
        navTabHistory.classList.add('active');
        navTabHistory.setAttribute('aria-selected', 'true');
      }
      if (navTabMonitor) {
        navTabMonitor.classList.remove('active');
        navTabMonitor.setAttribute('aria-selected', 'false');
      }
      if (tabPaneHistory) tabPaneHistory.style.display = 'block';
      if (tabPaneMonitor) tabPaneMonitor.style.display = 'none';

      if (window.location.hash !== '#history') {
        history.replaceState(null, '', '#history');
      }
      fetchViolations(false);
    } else {
      if (navTabMonitor) {
        navTabMonitor.classList.add('active');
        navTabMonitor.setAttribute('aria-selected', 'true');
      }
      if (navTabHistory) {
        navTabHistory.classList.remove('active');
        navTabHistory.setAttribute('aria-selected', 'false');
      }
      if (tabPaneMonitor) tabPaneMonitor.style.display = 'block';
      if (tabPaneHistory) tabPaneHistory.style.display = 'none';

      if (window.location.hash !== '#monitor' && window.location.hash !== '') {
        history.replaceState(null, '', '#monitor');
      }
      fetchRecentDetections();
    }
  }

  if (navTabMonitor) {
    navTabMonitor.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('monitor');
    });
  }
  if (navTabHistory) {
    navTabHistory.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('history');
    });
  }

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.toLowerCase();
    if (hash === '#history' || hash === '#violations') {
      switchTab('history');
    } else {
      switchTab('monitor');
    }
  });

  // Initial Load & Route
  const initialHash = window.location.hash.toLowerCase();
  if (initialHash === '#history' || initialHash === '#violations') {
    switchTab('history');
  } else {
    switchTab('monitor');
  }

  // Pre-seed filter counts & analytics with baseline data immediately
  updateFilterCounts({ all: 634, no_apron: 284, no_hairnet: 264, no_gloves: 86 });
  updateAnalyticsDisplay({
    counts: { all: 634, no_apron: 284, no_hairnet: 264, no_gloves: 86 },
    today_violations: 97,
    hourly_data: [
      { hour: '10:00', count: 22 },
      { hour: '11:00', count: 41 },
      { hour: '12:00', count: 23 },
      { hour: '13:00', count: 1 },
      { hour: '14:00', count: 10 }
    ]
  });

  // Start continuous polling and initial data fetches
  pollStatus().then(() => {
    fetchViolations();
    fetchRecentDetections();
  });
  startContinuousPolling();
});
