/**
 * Mother's Hut - 30-Minute Master Operations Timeline Client
 * Production-ready searching, filtering, and pagination.
 */

// API Configuration
const API_URL = "/api/master-metrics";
const POLL_INTERVAL_MS = 20000; // Refresh every 20s

// Current View State
const state = {
  page: 1,
  limit: 10, // Initial view: 10 records = 5 hours of 30-minute intervals
  search: "",
  date: "",
  scoreFilter: "all",
  availableDates: [],
  totalPages: 1,
  totalRecords: 0
};

let autoRefreshTimer = null;
let searchDebounceTimer = null;

// Helpers: Status Class Determination
function getScoreClass(score) {
  if (score === null || score === undefined || isNaN(score)) return "";
  const num = parseFloat(score);
  if (num >= 90) return "score-high";
  if (num >= 80) return "score-warning";
  if (num >= 70) return "score-orange";
  return "score-critical";
}

function formatVal(val, suffix = "") {
  if (val === null || val === undefined || isNaN(val)) return "--";
  const num = Number(val);
  const display = Number.isInteger(num) ? num.toString() : num.toFixed(1);
  return `${display}${suffix}`;
}

// Update Top Metric Cards (reflects the latest available 30-min window)
function updateSummaryPills(items) {
  if (!items || items.length === 0) return;

  const latest = items[0];
  const vehicleEl = document.getElementById("statVehicles");
  const ordersEl = document.getElementById("statOrders");
  const hygieneEl = document.getElementById("statHygiene");
  const qualityEl = document.getElementById("statQuality");

  if (vehicleEl) vehicleEl.textContent = formatVal(latest.parked_vehicles);
  if (ordersEl) ordersEl.textContent = formatVal(latest.food_orders);

  if (hygieneEl) {
    hygieneEl.textContent = formatVal(latest.hygiene_score, "%");
    hygieneEl.className = "pill-value " + getScoreClass(latest.hygiene_score);
  }

  if (qualityEl) {
    if (latest.food_quality && latest.food_quality > 0) {
      qualityEl.textContent = formatVal(latest.food_quality, "%");
      qualityEl.className = "pill-value " + getScoreClass(latest.food_quality);
    } else {
      qualityEl.textContent = "--";
      qualityEl.className = "pill-value";
    }
  }
}

// Populate Date Filter Dropdown options dynamically
function updateDateFilterDropdown(dates) {
  const select = document.getElementById("dateFilter");
  if (!select) return;

  const currentVal = select.value;
  // Keep first option "All Available Dates"
  select.innerHTML = '<option value="">All Available Dates</option>';

  dates.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d;
    // Format "YYYY-MM-DD" into readable "Nov 15, 2026"
    try {
      const parts = d.split("-");
      const dt = new Date(parts[0], parts[1] - 1, parts[2]);
      opt.textContent = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      opt.textContent = d;
    }
    select.appendChild(opt);
  });

  if (currentVal && dates.includes(currentVal)) {
    select.value = currentVal;
  }
}

// Render Timeline Feed (matching requested 2x2 grid and numbered stepper)
function renderTimeline(items) {
  const container = document.getElementById("timelineList");
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="state-box">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="margin: 0 auto 12px auto; color: var(--text-muted);" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <p style="color: var(--text-primary); font-weight: 600; font-size: 0.95rem; margin-bottom: 4px;">No timeline records match your filter criteria.</p>
        <p style="color: var(--text-muted); font-size: 0.82rem;">Try selecting a different date range or resetting search filters.</p>
      </div>
    `;
    return;
  }

  let html = "";
  const baseOffset = (state.page - 1) * state.limit;

  items.forEach((item, index) => {
    const itemNum = baseOffset + index + 1;
    const hygieneClass = getScoreClass(item.hygiene_score);
    const qualityClass = getScoreClass(item.food_quality);

    html += `
      <div class="timeline-item" data-index="${index}">
        <!-- Left vertical sequence indicator & connecting line -->
        <div class="timeline-left">
          <div class="timeline-num-badge">${itemNum}</div>
          <div class="timeline-line"></div>
        </div>

        <!-- Right metric card -->
        <div class="timeline-card">
          <!-- Card Header (Time Window: 30-minute interval) -->
          <div class="card-header-bar">
            <div class="time-range-display">
              <span>${item.time_window || "--"}</span>
              <span class="interval-badge-pill">30-min avg</span>
            </div>
            <div class="date-label-text">${item.date_label || ""}</div>
          </div>

          <!-- 2x2 Primary Measurements Grid -->
          <div class="measurements-grid">
            <!-- Parked Vehicles (Mean occupancy) -->
            <div class="measure-col">
              <span class="measure-label">Parked vehicles</span>
              <span class="measure-value">${formatVal(item.parked_vehicles)}</span>
            </div>

            <!-- Food Orders (Accumulated volume) -->
            <div class="measure-col">
              <span class="measure-label">Food orders</span>
              <span class="measure-value">${formatVal(item.food_orders)}</span>
            </div>

            <!-- Hygiene Score (Mean vision score) -->
            <div class="measure-col">
              <span class="measure-label">Hygiene score</span>
              <span class="measure-value ${hygieneClass}">
                ${formatVal(item.hygiene_score, "%")}
              </span>
            </div>

            <!-- Food Quality (Mean quality rating) -->
            <div class="measure-col">
              <span class="measure-label">Food quality</span>
              <span class="measure-value ${qualityClass}">
                ${item.food_quality && item.food_quality > 0 ? formatVal(item.food_quality, "%") : "--"}
              </span>
            </div>
          </div>

          <!-- Secondary Operational Meta -->
          <div class="card-meta-footer">
            <div class="meta-group">
              <div class="meta-item">
                <span>Footfall:</span>
                <strong>${formatVal(item.customer_count)} visitors</strong>
              </div>
              <div class="meta-item">
                <span>Data points:</span>
                <strong>${item.samples_count || 1} readings aggregated</strong>
              </div>
            </div>
            <div class="meta-item">
              <span style="font-size: 0.72rem; color: var(--mh-gold);">● Master Synced</span>
            </div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Update Pagination Controls
function updatePaginationControls(pagination) {
  state.totalPages = pagination.total_pages || 1;
  state.totalRecords = pagination.total_records || 0;

  const infoEl = document.getElementById("paginationInfo");
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  const indicatorEl = document.getElementById("pageIndicator");
  const recCountEl = document.getElementById("recordsCountText");
  const coverageTag = document.getElementById("hoursCoverageTag");
  const summaryEl = document.getElementById("activeFilterSummary");

  if (infoEl) {
    infoEl.textContent = `Showing page ${state.page} of ${state.totalPages} (${state.totalRecords} total 30-min intervals)`;
  }

  if (recCountEl) {
    recCountEl.textContent = `${state.totalRecords} intervals found`;
  }

  if (coverageTag) {
    const hours = (pagination.hours_in_view || 0).toFixed(1);
    coverageTag.textContent = `${hours} Hours Displayed (${pagination.page} / ${state.totalPages})`;
  }

  if (summaryEl) {
    if (state.search || state.date || state.scoreFilter !== "all") {
      summaryEl.textContent = `Filtered View (${state.totalRecords} intervals)`;
    } else {
      summaryEl.textContent = `Initial View: ${Math.min(state.limit, state.totalRecords)} Intervals (5.0 Hours)`;
    }
  }

  if (indicatorEl) {
    indicatorEl.textContent = `${state.page} / ${state.totalPages}`;
  }

  if (prevBtn) prevBtn.disabled = !pagination.has_prev;
  if (nextBtn) nextBtn.disabled = !pagination.has_next;
}

// Core API Fetch Function
async function fetchTimelineData(showLoading = false) {
  const syncStatus = document.getElementById("syncStatusText");
  const container = document.getElementById("timelineList");

  if (showLoading && container) {
    container.innerHTML = `
      <div class="state-box">
        <div class="loading-spinner"></div>
        <p style="color: var(--text-secondary); font-size: 0.9rem;">Aggregating 30-minute intervals from Master Database...</p>
      </div>
    `;
  }

  if (syncStatus) {
    syncStatus.textContent = "Syncing with Master DB...";
  }

  try {
    const params = new URLSearchParams({
      limit: state.limit.toString(),
      page: state.page.toString()
    });

    if (state.date) params.append("date", state.date);
    if (state.search) params.append("search", state.search);
    if (state.scoreFilter && state.scoreFilter !== "all") {
      params.append("score_filter", state.scoreFilter);
    }

    const res = await fetch(`${API_URL}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const json = await res.json();

    const items = json.data || [];
    const pagination = json.pagination || {};

    // Populate date dropdown once or when new dates arrive
    if (json.available_dates && json.available_dates.length > 0) {
      if (JSON.stringify(json.available_dates) !== JSON.stringify(state.availableDates)) {
        state.availableDates = json.available_dates;
        updateDateFilterDropdown(state.availableDates);
      }
    }

    // Render components
    updateSummaryPills(items);
    renderTimeline(items);
    updatePaginationControls(pagination);

    if (syncStatus) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      syncStatus.textContent = `Master DB Connected (${timeStr})`;
    }
  } catch (err) {
    console.error("Master DB fetch error:", err);
    if (syncStatus) {
      syncStatus.textContent = "Offline cache / Connection warning";
    }
  }
}

// Filter Event Listeners Setup
function initControls() {
  const searchInput = document.getElementById("searchInput");
  const dateFilter = document.getElementById("dateFilter");
  const scoreFilter = document.getElementById("scoreFilter");
  const resetBtn = document.getElementById("resetFiltersBtn");
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  const refreshBtn = document.getElementById("refreshBtn");

  // Search Input with Debounce
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        state.page = 1; // Reset to page 1 on search
        fetchTimelineData(true);
      }, 350);
    });
  }

  // Date Filter Change
  if (dateFilter) {
    dateFilter.addEventListener("change", (e) => {
      state.date = e.target.value;
      state.page = 1;
      fetchTimelineData(true);
    });
  }

  // Score Filter Change
  if (scoreFilter) {
    scoreFilter.addEventListener("change", (e) => {
      state.scoreFilter = e.target.value;
      state.page = 1;
      fetchTimelineData(true);
    });
  }

  // Reset Filters
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      state.page = 1;
      state.search = "";
      state.date = "";
      state.scoreFilter = "all";

      if (searchInput) searchInput.value = "";
      if (dateFilter) dateFilter.value = "";
      if (scoreFilter) scoreFilter.value = "all";

      fetchTimelineData(true);
    });
  }

  // Pagination Handlers
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        fetchTimelineData(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        fetchTimelineData(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  // Manual Refresh
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchTimelineData(true);
    });
  }
}

// Theme Switcher (Dark / Light)
function initTheme() {
  const toggleBtn = document.getElementById("themeToggleBtn");
  if (!toggleBtn) return;

  const savedTheme = localStorage.getItem("mh_theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeButton(savedTheme);

  toggleBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("mh_theme", next);
    updateThemeButton(next);
  });
}

function updateThemeButton(theme) {
  const icon = document.getElementById("themeIcon");
  const text = document.getElementById("themeText");
  if (theme === "light") {
    if (icon) icon.textContent = "🌙";
    if (text) text.textContent = "Dark";
  } else {
    if (icon) icon.textContent = "☀️";
    if (text) text.textContent = "Light";
  }
}

// Initial Boot
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initControls();
  fetchTimelineData(true);

  // Background Auto-sync
  autoRefreshTimer = setInterval(() => {
    fetchTimelineData(false);
  }, POLL_INTERVAL_MS);
});
