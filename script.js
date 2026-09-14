/**
 * Energy Price Monitor — στατική ιστοσελίδα
 *
 * Ίδιο backend με το iOS app: Supabase/PostgREST, πίνακας `prices`.
 * Καμία κλήση στο ENTSO-E από τον browser — μόνο διάβασμα του ήδη
 * συγκεντρωμένου πίνακα, ακριβώς όπως κάνει και η εφαρμογή.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Ρυθμίσεις
  // ---------------------------------------------------------------------

  const CONFIG = {
    supabaseUrl: "https://mlwzujsjdrsuyxbkpevy.supabase.co",
    // Δημόσιο "publishable" key — ασφαλές να ταξιδεύει στο client-side JS.
    // Το πραγματικό όριο ασφαλείας είναι το Row Level Security του πίνακα
    // `prices` στο Supabase (δημόσιο SELECT, καμία policy για write).
    supabaseKey: "sb_publishable_84A2IIao77Zrc-mqjr1ysw_M5cSU6MC",
    timeZone: "Europe/Athens",
    // Η αυριανή ημέρα θεωρείται «δημοσιευμένη» όταν έχουν έρθει τουλάχιστον
    // τόσες περίοδοι από τα ~96 δεκαπεντάλεπτα μιας κανονικής ημέρας.
    minPeriodsForPublished: 90,
  };

  const COLORS = {
    accent: "#18e0b2",
    accentFill: "rgba(24, 224, 178, 0.16)",
    negative: "#ff453a",
    negativeFill: "rgba(255, 69, 58, 0.16)",
    zero: "#30d5c8",
    grid: "rgba(235, 235, 245, 0.12)",
    tick: "rgba(235, 235, 245, 0.6)",
  };

  const ERROR_MESSAGES = {
    unauthorized: "Δεν υπάρχει εξουσιοδότηση για πρόσβαση στα δεδομένα τιμών.",
    rate_limited: "Ο server περιόρισε προσωρινά τα αιτήματα. Δοκιμάστε ξανά σε λίγο.",
    server_error: "Ο server επέστρεψε προσωρινό σφάλμα. Δοκιμάστε αργότερα.",
    invalid_response: "Η απάντηση δεν είχε αναμενόμενη μορφή.",
    parsing_failed: "Δεν ήταν δυνατή η ανάγνωση των δεδομένων τιμών.",
    network: "Δεν υπάρχει σύνδεση στο internet.",
  };

  class AppError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------
  // Μορφοποιητές (ίδιο ύφος με το iOS app: el-GR, Europe/Athens)
  // ---------------------------------------------------------------------

  const priceFormatter = new Intl.NumberFormat("el-GR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const timeFormatter = new Intl.DateTimeFormat("el-GR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: CONFIG.timeZone,
  });

  const dayTitleFormatter = new Intl.DateTimeFormat("el-GR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: CONFIG.timeZone,
  });

  const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: CONFIG.timeZone,
  });

  function formatPrice(value) {
    return priceFormatter.format(value);
  }

  function formatTime(isoString) {
    return timeFormatter.format(new Date(isoString));
  }

  function formatDayTitle(ymd) {
    // Μεσημέρι UTC αποφεύγει τυχόν ζητήματα ζώνης ώρας γύρω από τα
    // μεσάνυχτα Αθήνας — η ημερολογιακή ημέρα του ymd δεν επηρεάζεται.
    const date = new Date(`${ymd}T12:00:00Z`);
    const text = dayTitleFormatter.format(date);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function todayYMD() {
    return ymdFormatter.format(new Date());
  }

  function addDaysYMD(ymd, days) {
    const [year, month, day] = ymd.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function formatDuration(totalMinutes) {
    const minutes = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;

    if (hours === 0 && remainder === 0) return "0 λεπτά";
    if (hours === 0) return `${remainder} λεπτά`;
    if (remainder === 0) return hours === 1 ? "1 ώρα" : `${hours} ώρες`;
    if (hours === 1) return `1 ώρα ${remainder} λεπτά`;
    return `${hours} ώρες ${remainder} λεπτά`;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Δίκτυο
  // ---------------------------------------------------------------------

  async function fetchPrices(deliveryDate) {
    const url = new URL(`${CONFIG.supabaseUrl}/rest/v1/prices`);
    url.searchParams.set("select", "start_time,end_time,price_eur_mwh,resolution_min");
    url.searchParams.set("delivery_date", `eq.${deliveryDate}`);
    url.searchParams.set("order", "start_time.asc");

    let response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          apikey: CONFIG.supabaseKey,
          Authorization: `Bearer ${CONFIG.supabaseKey}`,
          Accept: "application/json",
        },
      });
    } catch (networkError) {
      throw new AppError("network");
    }

    if (response.status === 401 || response.status === 403) throw new AppError("unauthorized");
    if (response.status === 429) throw new AppError("rate_limited");
    if (response.status >= 500) throw new AppError("server_error");
    if (!response.ok) throw new AppError("invalid_response");

    let rows;
    try {
      rows = await response.json();
    } catch (parseError) {
      throw new AppError("parsing_failed");
    }

    return rows.map((row) => ({
      startTime: row.start_time,
      endTime: row.end_time,
      price: Number(row.price_eur_mwh),
      resolutionMin: Number(row.resolution_min) || 15,
    }));
  }

  // ---------------------------------------------------------------------
  // Υπολογισμοί
  // ---------------------------------------------------------------------

  function summarize(periods) {
    const prices = periods.map((p) => p.price);
    const sum = prices.reduce((total, value) => total + value, 0);
    const average = sum / periods.length;
    const minimum = Math.min(...prices);
    const maximum = Math.max(...prices);

    const zeroMinutes = periods
      .filter((p) => p.price === 0)
      .reduce((total, p) => total + p.resolutionMin, 0);
    const negativeMinutes = periods
      .filter((p) => p.price < 0)
      .reduce((total, p) => total + p.resolutionMin, 0);

    return {
      average,
      minimum,
      maximum,
      zeroCount: periods.filter((p) => p.price === 0).length,
      negativeCount: periods.filter((p) => p.price < 0).length,
      zeroMinutes,
      negativeMinutes,
    };
  }

  function findCurrentPeriod(periods) {
    const now = Date.now();
    return periods.find((p) => {
      const start = new Date(p.startTime).getTime();
      const end = new Date(p.endTime).getTime();
      return start <= now && now < end;
    });
  }

  function priceStatusClass(value) {
    if (value < 0) return "is-negative";
    if (value === 0) return "is-zero";
    return "";
  }

  // ---------------------------------------------------------------------
  // Απόδοση οθονών κατάστασης
  // ---------------------------------------------------------------------

  const content = document.getElementById("content");

  function renderLoading() {
    content.innerHTML = `
      <div class="state">
        <div class="spinner" role="status" aria-label="Φόρτωση"></div>
        <p class="state__message">Φόρτωση τιμών…</p>
      </div>`;
  }

  function renderTomorrowPending() {
    content.innerHTML = `
      <div class="state is-warning">
        <div class="state__icon" aria-hidden="true">⏳</div>
        <p class="state__title">Οι αυριανές τιμές δεν έχουν δημοσιευτεί ακόμη</p>
        <p class="state__message">Δοκίμασε ξανά αργότερα.</p>
      </div>`;
  }

  function renderEmpty(day) {
    const message =
      day === "tomorrow"
        ? "Δεν βρέθηκαν τιμές για την αυριανή ημέρα."
        : "Δεν βρέθηκαν τιμές για τη σημερινή ημέρα.";
    content.innerHTML = `
      <div class="state">
        <div class="state__icon" aria-hidden="true">📭</div>
        <p class="state__title">Δεν υπάρχουν δεδομένα</p>
        <p class="state__message">${message}</p>
      </div>`;
  }

  function renderError(error) {
    const message =
      (error && error.code && ERROR_MESSAGES[error.code]) ||
      "Δεν ήταν δυνατή η φόρτωση των τιμών. Δοκιμάστε ξανά.";
    content.innerHTML = `
      <div class="state is-error">
        <div class="state__icon" aria-hidden="true">⚠️</div>
        <p class="state__title">Αποτυχία φόρτωσης</p>
        <p class="state__message">${escapeHtml(message)}</p>
        <button class="retry-button" type="button" id="retry-button">Δοκιμάστε ξανά</button>
      </div>`;
    const retryButton = document.getElementById("retry-button");
    retryButton.addEventListener("click", () => loadDay(state.activeDay, { force: true }));
  }

  function renderData(day, ymd, periods) {
    const summary = summarize(periods);
    const currentPeriod = day === "today" ? findCurrentPeriod(periods) : null;
    const heroPrice = currentPeriod ? currentPeriod.price : summary.average;
    const heroLabel = currentPeriod ? "Τρέχουσα τιμή" : "Μέση τιμή ημέρας";
    const heroClass = priceStatusClass(heroPrice);

    content.innerHTML = `
      <div class="stack">
        <section class="card hero-card">
          <div class="hero-card__top">
            <span class="hero-card__date">${formatDayTitle(ymd)}</span>
            <span class="badge"><span aria-hidden="true">📡</span> ENTSO-E</span>
          </div>

          <p class="hero-card__label">${heroLabel}</p>
          <div class="hero-card__price-row">
            <span class="hero-card__price ${heroClass}">${formatPrice(heroPrice)}</span>
            <span class="hero-card__unit">€/MWh</span>
          </div>
          ${
            currentPeriod
              ? `<p class="hero-card__period">Περίοδος ${formatTime(currentPeriod.startTime)}–${formatTime(currentPeriod.endTime)}</p>`
              : ""
          }

          <div class="hero-card__stats">
            <div class="hero-stat">
              <span class="hero-stat__label">Ελάχιστη</span>
              <span class="hero-stat__value ${priceStatusClass(summary.minimum)}">${formatPrice(summary.minimum)}</span>
            </div>
            <div class="hero-stat">
              <span class="hero-stat__label">Μέση</span>
              <span class="hero-stat__value">${formatPrice(summary.average)}</span>
            </div>
            <div class="hero-stat">
              <span class="hero-stat__label">Μέγιστη</span>
              <span class="hero-stat__value">${formatPrice(summary.maximum)}</span>
            </div>
          </div>
        </section>

        <section class="card chart-card">
          <h2>Τιμές ημέρας</h2>
          <div class="chart-wrap">
            <canvas id="price-chart" role="img" aria-label="Γράφημα τιμών ρεύματος ανά περίοδο της ημέρας"></canvas>
          </div>
        </section>

        <div class="stats-grid">
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">⭘</span> Μηδενικές</span>
            <span class="metric-card__value">${formatDuration(summary.zeroMinutes)}</span>
            <span class="metric-card__detail">${summary.zeroCount} περίοδοι</span>
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">➖</span> Αρνητικές</span>
            <span class="metric-card__value ${summary.negativeCount > 0 ? "is-negative" : ""}">${formatDuration(summary.negativeMinutes)}</span>
            <span class="metric-card__detail">${summary.negativeCount === 0 ? "Καμία" : `${summary.negativeCount} περίοδοι`}</span>
          </div>
        </div>
      </div>`;

    renderChart(periods);
  }

  // ---------------------------------------------------------------------
  // Γράφημα (Chart.js από CDN)
  // ---------------------------------------------------------------------

  let chartInstance = null;

  function renderChart(periods) {
    const canvas = document.getElementById("price-chart");
    if (!canvas || typeof Chart === "undefined") return;

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    const labels = periods.map((p) => formatTime(p.startTime));
    const values = periods.map((p) => p.price);

    chartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: COLORS.accent,
            backgroundColor: COLORS.accentFill,
            borderWidth: 2,
            fill: true,
            stepped: "after",
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: COLORS.accent,
            tension: 0,
            // Χρωματίζει σε κόκκινο τα τμήματα της γραμμής όπου η τιμή
            // είναι αρνητική, χωρίς να χρειάζεται ξεχωριστό dataset.
            segment: {
              borderColor: (ctx) =>
                ctx.p0.parsed.y < 0 && ctx.p1.parsed.y < 0 ? COLORS.negative : undefined,
              backgroundColor: (ctx) =>
                ctx.p0.parsed.y < 0 && ctx.p1.parsed.y < 0 ? COLORS.negativeFill : undefined,
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `${formatPrice(item.parsed.y)} €/MWh`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: COLORS.tick,
              maxTicksLimit: 8,
              autoSkip: true,
            },
          },
          y: {
            grid: { color: COLORS.grid },
            ticks: {
              color: COLORS.tick,
              callback: (value) => formatPrice(value),
            },
          },
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Ροή φόρτωσης / κατάσταση καρτελών
  // ---------------------------------------------------------------------

  const cache = new Map(); // ymd -> periods[]

  const state = {
    activeDay: "today",
  };

  async function loadDay(day, { force = false } = {}) {
    state.activeDay = day;
    const ymd = day === "today" ? todayYMD() : addDaysYMD(todayYMD(), 1);

    renderLoading();
    setRefreshing(true);

    try {
      let periods;
      if (!force && cache.has(ymd)) {
        periods = cache.get(ymd);
      } else {
        periods = await fetchPrices(ymd);
        cache.set(ymd, periods);
      }

      // Δεν είναι πλέον η ενεργή καρτέλα — ο χρήστης άλλαξε καρτέλα όσο
      // περιμέναμε την απάντηση του δικτύου.
      if (state.activeDay !== day) return;

      if (day === "tomorrow" && periods.length < CONFIG.minPeriodsForPublished) {
        renderTomorrowPending();
        return;
      }

      if (periods.length === 0) {
        renderEmpty(day);
        return;
      }

      renderData(day, ymd, periods);
    } catch (error) {
      if (state.activeDay !== day) return;
      renderError(error);
    } finally {
      if (state.activeDay === day) setRefreshing(false);
    }
  }

  function setRefreshing(isLoading) {
    refreshButton.classList.toggle("is-loading", isLoading);
    refreshButton.disabled = isLoading;
  }

  // ---------------------------------------------------------------------
  // UI events
  // ---------------------------------------------------------------------

  const tabButtons = Array.from(document.querySelectorAll(".tab"));
  const refreshButton = document.getElementById("refresh-button");

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const day = button.dataset.day;
      if (day === state.activeDay) return;

      tabButtons.forEach((b) => {
        b.classList.toggle("is-active", b === button);
        b.setAttribute("aria-selected", b === button ? "true" : "false");
      });

      loadDay(day);
    });
  });

  refreshButton.addEventListener("click", () => loadDay(state.activeDay, { force: true }));

  // Ξαναζωγραφίζει την τρέχουσα περίοδο κάθε λεπτό χωρίς νέο αίτημα δικτύου,
  // ώστε η ένδειξη «τώρα» να παραμένει σωστή όσο η σελίδα μένει ανοιχτή.
  setInterval(() => {
    if (state.activeDay !== "today") return;
    const ymd = todayYMD();
    if (!cache.has(ymd)) return;
    renderData("today", ymd, cache.get(ymd));
  }, 60_000);

  loadDay("today");
})();
