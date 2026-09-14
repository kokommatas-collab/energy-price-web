/**
 * Energy Price Monitor — στατική ιστοσελίδα
 *
 * Ίδιο backend με το iOS app: Supabase/PostgREST, πίνακας `prices`.
 * Καμία κλήση στο ENTSO-E από τον browser — μόνο διάβασμα του ήδη
 * συγκεντρωμένου πίνακα, ακριβώς όπως κάνει και η εφαρμογή.
 *
 * Δομή:
 *   1. Ρυθμίσεις / μορφοποιητές
 *   2. Δίκτυο (fetch + pagination — το PostgREST περιορίζει σε 1000
 *      γραμμές ανά request, άρα ένας πλήρης μήνας σε ανάλυση 15λέπτου
 *      χρειάζεται 3 σελίδες)
 *   3. Υπολογισμοί (ημερήσιοι/μηνιαίοι, πάντα με βάση το πραγματικό
 *      resolution_min κάθε γραμμής — ποτέ σταθερό πολλαπλασιαστή)
 *   4. Οθόνες κατάστασης (loading/empty/error) — reusable σε container
 *   5. Λεπτομέρεια ημέρας (hero + γράφημα) — reusable σε Σήμερα/Αύριο/Ιστορικό
 *   6. Ιστορικό: ημέρα (date picker) + μήνας (πλέγμα λίστας + στατιστικά)
 *   7. Καλωδίωση UI (tabs, refresh, αρχικοποίηση)
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // 1. Ρυθμίσεις
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
    // Το PostgREST (Supabase) επιστρέφει το πολύ τόσες γραμμές ανά αίτημα,
    // ανεξάρτητα από το `limit` που ζητηθεί — επιβεβαιωμένο εμπειρικά.
    pageSize: 1000,
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

  const GREEK_MONTHS = [
    "Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος",
    "Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος",
  ];

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

  const dayShortFormatter = new Intl.DateTimeFormat("el-GR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: CONFIG.timeZone,
  });

  const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: CONFIG.timeZone,
  });

  function formatPrice(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    return priceFormatter.format(value);
  }

  function formatTime(isoString) {
    return timeFormatter.format(new Date(isoString));
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatDayTitle(ymdValue) {
    // Μεσημέρι UTC αποφεύγει τυχόν ζητήματα ζώνης ώρας γύρω από τα
    // μεσάνυχτα Αθήνας — η ημερολογιακή ημέρα του ymd δεν επηρεάζεται.
    return capitalize(dayTitleFormatter.format(new Date(`${ymdValue}T12:00:00Z`)));
  }

  function formatDayShort(ymdValue) {
    return capitalize(dayShortFormatter.format(new Date(`${ymdValue}T12:00:00Z`)));
  }

  function todayYMD() {
    return ymdFormatter.format(new Date());
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function ymd(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function parseYMD(value) {
    const [year, month, day] = value.split("-").map(Number);
    return { year, month, day };
  }

  function monthKey(year, month) {
    return `${year}-${pad2(month)}`;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function addDaysYMD(ymdValue, days) {
    const { year, month, day } = parseYMD(ymdValue);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function compareYMD(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function clampYMD(value, min, max) {
    if (min && compareYMD(value, min) < 0) return min;
    if (max && compareYMD(value, max) > 0) return max;
    return value;
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
  // 2. Δίκτυο
  // ---------------------------------------------------------------------

  function authHeaders() {
    return {
      apikey: CONFIG.supabaseKey,
      Authorization: `Bearer ${CONFIG.supabaseKey}`,
      Accept: "application/json",
    };
  }

  function statusToError(status) {
    if (status === 401 || status === 403) return new AppError("unauthorized");
    if (status === 429) return new AppError("rate_limited");
    if (status >= 500) return new AppError("server_error");
    return new AppError("invalid_response");
  }

  /**
   * Φέρνει ΟΛΕΣ τις γραμμές που ταιριάζουν στα `paramPairs`, σελιδοποιώντας
   * αυτόματα ανά `CONFIG.pageSize` — απαραίτητο γιατί το Supabase κόβει
   * σιωπηλά στις 1000 γραμμές ανά αίτημα, και ένας πλήρης μήνας σε
   * ανάλυση 15λέπτου έχει έως ~2980.
   *
   * `paramPairs` είναι λίστα [κλειδί, τιμή] (όχι object) ώστε να στέλνονται
   * δύο φίλτρα με το ίδιο όνομα (π.χ. delivery_date=gte...&delivery_date=lte...).
   */
  async function fetchAllRows(paramPairs) {
    const all = [];
    let offset = 0;

    while (true) {
      const url = new URL(`${CONFIG.supabaseUrl}/rest/v1/prices`);
      for (const [key, value] of paramPairs) url.searchParams.append(key, value);
      url.searchParams.set("limit", String(CONFIG.pageSize));
      url.searchParams.set("offset", String(offset));

      let response;
      try {
        response = await fetch(url.toString(), { headers: authHeaders() });
      } catch (networkError) {
        throw new AppError("network");
      }
      if (!response.ok) throw statusToError(response.status);

      let rows;
      try {
        rows = await response.json();
      } catch (parseError) {
        throw new AppError("parsing_failed");
      }

      all.push(...rows);
      if (rows.length < CONFIG.pageSize) break;
      offset += CONFIG.pageSize;
    }

    return all;
  }

  function fetchDayRows(ymdValue) {
    return fetchAllRows([
      ["select", "start_time,end_time,price_eur_mwh,resolution_min"],
      ["delivery_date", `eq.${ymdValue}`],
      ["order", "start_time.asc"],
    ]).then(normalizeRows);
  }

  function fetchMonthRows(year, month) {
    const first = ymd(year, month, 1);
    const last = ymd(year, month, daysInMonth(year, month));
    return fetchAllRows([
      ["select", "start_time,end_time,price_eur_mwh,resolution_min,delivery_date"],
      ["delivery_date", `gte.${first}`],
      ["delivery_date", `lte.${last}`],
      ["order", "start_time.asc"],
    ]).then((rows) => rows.map((row) => ({ ...normalizeRow(row), deliveryDate: row.delivery_date })));
  }

  function normalizeRow(row) {
    return {
      startTime: row.start_time,
      endTime: row.end_time,
      price: Number(row.price_eur_mwh),
      resolutionMin: Number(row.resolution_min) || 15,
    };
  }

  function normalizeRows(rows) {
    return rows.map(normalizeRow);
  }

  /** Το παλαιότερο/νεότερο `delivery_date` που υπάρχει στον πίνακα. */
  async function fetchBoundDate(order) {
    const url = new URL(`${CONFIG.supabaseUrl}/rest/v1/prices`);
    url.searchParams.set("select", "delivery_date");
    url.searchParams.set("order", order);
    url.searchParams.set("limit", "1");

    let response;
    try {
      response = await fetch(url.toString(), { headers: authHeaders() });
    } catch (networkError) {
      throw new AppError("network");
    }
    if (!response.ok) throw statusToError(response.status);

    let rows;
    try {
      rows = await response.json();
    } catch (parseError) {
      throw new AppError("parsing_failed");
    }
    return rows[0] ? rows[0].delivery_date : null;
  }

  async function fetchDateBounds() {
    if (state.bounds) return state.bounds;
    const [min, max] = await Promise.all([
      fetchBoundDate("delivery_date.asc"),
      fetchBoundDate("delivery_date.desc"),
    ]);
    state.bounds = { min, max };
    return state.bounds;
  }

  // ---------------------------------------------------------------------
  // 3. Υπολογισμοί
  // ---------------------------------------------------------------------

  /** Απλός μέσος όρος ημέρας — ίδιο μοτίβο με το PricePeriodCalculator.summary
   *  του iOS app (όχι σταθμισμένος κατά διάρκεια σε αυτό το επίπεδο). */
  function summarize(periods) {
    const prices = periods.map((p) => p.price);
    const sum = prices.reduce((total, value) => total + value, 0);
    const average = sum / periods.length;

    const zeroMinutes = periods
      .filter((p) => p.price === 0)
      .reduce((total, p) => total + p.resolutionMin, 0);
    const negativeMinutes = periods
      .filter((p) => p.price < 0)
      .reduce((total, p) => total + p.resolutionMin, 0);

    return {
      average,
      minimum: Math.min(...prices),
      maximum: Math.max(...prices),
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

  function groupByDeliveryDate(rows) {
    const map = new Map();
    for (const row of rows) {
      const list = map.get(row.deliveryDate);
      if (list) {
        list.push(row);
      } else {
        map.set(row.deliveryDate, [row]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0));
    }
    return map;
  }

  /**
   * Στατιστικά μήνα από το σύνολο των ημερήσιων περιόδων.
   *
   * - Μέση τιμή μήνα: σταθμισμένη κατά διάρκεια (ίδιο μοτίβο με
   *   `MonthlyPriceStatistics`/`weightedAveragePrice` του iOS app) — μια
   *   ωριαία περίοδος μετράει 4x όσο μια δεκαπεντάλεπτη στον μέσο όρο.
   * - Διάρκειες μηδενικών/αρνητικών: άθροισμα του πραγματικού
   *   `resolutionMin` κάθε γραμμής, ποτέ σταθερό πολλαπλασιαστή — έτσι
   *   βγαίνουν σωστά και σε μήνα αλλαγής ανάλυσης (Οκτώβριος 2025).
   * - Μεγαλύτερη αρνητική ακολουθία: υπολογίζεται ΑΝΑ ΗΜΕΡΑ (ίδιος
   *   αλγόριθμος με το PriceStreakAnalyzer· διακόπτεται όταν το τέλος
   *   μιας περιόδου δεν ταυτίζεται με την αρχή της επόμενης — καλύπτει
   *   αυτόματα τις 23ωρες/25ωρες μέρες αλλαγής ώρας), και μετά κρατάμε τη
   *   μεγαλύτερη ανάμεσα στις μέρες του μήνα· έτσι ανήκει πάντα σε μία
   *   συγκεκριμένη μέρα, όπως και στην εφαρμογή.
   */
  function computeMonthlyStatistics(periodsByDay) {
    let totalSeconds = 0;
    let weightedSum = 0;
    let negativeMinutes = 0;
    let zeroMinutes = 0;
    const negativeDays = new Set();
    const zeroDays = new Set();
    let minObservation = null;
    let maxObservation = null;
    let longestNegative = null;

    for (const [day, periods] of periodsByDay) {
      for (const p of periods) {
        const seconds = p.resolutionMin * 60;
        totalSeconds += seconds;
        weightedSum += p.price * seconds;

        if (p.price < 0) {
          negativeMinutes += p.resolutionMin;
          negativeDays.add(day);
        }
        if (p.price === 0) {
          zeroMinutes += p.resolutionMin;
          zeroDays.add(day);
        }
        if (!minObservation || p.price < minObservation.price) {
          minObservation = { day, price: p.price, startTime: p.startTime, endTime: p.endTime };
        }
        if (!maxObservation || p.price > maxObservation.price) {
          maxObservation = { day, price: p.price, startTime: p.startTime, endTime: p.endTime };
        }
      }

      // Συνεχόμενη ακολουθία αρνητικών τιμών, μόνο μέσα στην ίδια ημέρα.
      let current = [];
      const flush = () => {
        if (current.length === 0) return;
        const durationMinutes = current.reduce((total, p) => total + p.resolutionMin, 0);
        if (!longestNegative || durationMinutes > longestNegative.durationMinutes) {
          longestNegative = {
            durationMinutes,
            day,
            startTime: current[0].startTime,
            endTime: current[current.length - 1].endTime,
          };
        }
      };
      for (const p of periods) {
        if (p.price < 0) {
          const previous = current[current.length - 1];
          if (previous && previous.endTime !== p.startTime) {
            flush();
            current = [p];
          } else {
            current.push(p);
          }
        } else {
          flush();
          current = [];
        }
      }
      flush();
    }

    return {
      averagePrice: totalSeconds > 0 ? weightedSum / totalSeconds : null,
      minObservation,
      maxObservation,
      negativeMinutes,
      zeroMinutes,
      negativeDayCount: negativeDays.size,
      zeroDayCount: zeroDays.size,
      longestNegative,
    };
  }

  // ---------------------------------------------------------------------
  // 4. Οθόνες κατάστασης — reusable σε οποιονδήποτε container
  // ---------------------------------------------------------------------

  function showLoading(container) {
    container.innerHTML = `
      <div class="state">
        <div class="spinner" role="status" aria-label="Φόρτωση"></div>
        <p class="state__message">Φόρτωση τιμών…</p>
      </div>`;
  }

  function showTomorrowPending(container) {
    container.innerHTML = `
      <div class="state is-warning">
        <div class="state__icon" aria-hidden="true">⏳</div>
        <p class="state__title">Οι αυριανές τιμές δεν έχουν δημοσιευτεί ακόμη</p>
        <p class="state__message">Δοκίμασε ξανά αργότερα.</p>
      </div>`;
  }

  function showEmpty(container, context) {
    const message =
      context === "tomorrow"
        ? "Δεν βρέθηκαν τιμές για την αυριανή ημέρα."
        : "Δεν βρέθηκαν τιμές για την επιλεγμένη ημέρα.";
    container.innerHTML = `
      <div class="state">
        <div class="state__icon" aria-hidden="true">📭</div>
        <p class="state__title">Δεν υπάρχουν δεδομένα</p>
        <p class="state__message">${message}</p>
      </div>`;
  }

  function showError(container, error, onRetry) {
    const message =
      (error && error.code && ERROR_MESSAGES[error.code]) ||
      "Δεν ήταν δυνατή η φόρτωση των τιμών. Δοκιμάστε ξανά.";
    container.innerHTML = `
      <div class="state is-error">
        <div class="state__icon" aria-hidden="true">⚠️</div>
        <p class="state__title">Αποτυχία φόρτωσης</p>
        <p class="state__message">${escapeHtml(message)}</p>
        <button class="retry-button" type="button">Δοκιμάστε ξανά</button>
      </div>`;
    container.querySelector(".retry-button").addEventListener("click", onRetry);
  }

  // ---------------------------------------------------------------------
  // 5. Λεπτομέρεια ημέρας — Σήμερα/Αύριο/Ιστορικό μοιράζονται αυτό το view
  // ---------------------------------------------------------------------

  function dayDetailHTML(ymdValue, periods) {
    const summary = summarize(periods);
    const isToday = ymdValue === todayYMD();
    const currentPeriod = isToday ? findCurrentPeriod(periods) : null;
    const heroPrice = currentPeriod ? currentPeriod.price : summary.average;
    const heroLabel = currentPeriod ? "Τρέχουσα τιμή" : "Μέση τιμή ημέρας";
    const heroClass = priceStatusClass(heroPrice);

    return `
      <div class="stack">
        <section class="card hero-card">
          <div class="hero-card__top">
            <span class="hero-card__date">${formatDayTitle(ymdValue)}</span>
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
          <h2 class="section-title">Τιμές ημέρας</h2>
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
  }

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
            ticks: { color: COLORS.tick, maxTicksLimit: 8, autoSkip: true },
          },
          y: {
            grid: { color: COLORS.grid },
            ticks: { color: COLORS.tick, callback: (value) => formatPrice(value) },
          },
        },
      },
    });
  }

  function showDayDetail(container, ymdValue, periods) {
    container.innerHTML = dayDetailHTML(ymdValue, periods);
    renderChart(periods);
  }

  // ---------------------------------------------------------------------
  // 6. Ιστορικό
  // ---------------------------------------------------------------------

  const dayCache = new Map(); // ymd -> periods[]
  const monthCache = new Map(); // "YYYY-MM" -> Map<ymd, periods[]>

  function subTabsHTML() {
    return `
      <div class="sub-tabs" role="tablist" aria-label="Προβολή ιστορικού">
        <button class="sub-tab ${state.historyMode === "day" ? "is-active" : ""}" data-mode="day" type="button" role="tab" aria-selected="${state.historyMode === "day"}">Ημέρα</button>
        <button class="sub-tab ${state.historyMode === "month" ? "is-active" : ""}" data-mode="month" type="button" role="tab" aria-selected="${state.historyMode === "month"}">Μήνας</button>
      </div>`;
  }

  function attachSubTabHandlers() {
    content.querySelectorAll(".sub-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.mode;
        if (mode === state.historyMode) return;
        state.historyMode = mode;
        renderHistory();
      });
    });
  }

  async function enterHistory() {
    showLoading(content);
    setRefreshing(true);
    try {
      await fetchDateBounds();
    } catch (error) {
      showError(content, error, enterHistory);
      return;
    } finally {
      setRefreshing(false);
    }

    if (!state.historyDayYMD) {
      state.historyDayYMD = clampYMD(todayYMD(), state.bounds.min, state.bounds.max);
    }
    if (!state.historyYear) {
      const parsed = parseYMD(state.historyDayYMD);
      state.historyYear = parsed.year;
      state.historyMonth = parsed.month;
    }
    renderHistory();
  }

  function renderHistory() {
    if (state.historyMode === "month") {
      renderHistoryMonthShell();
    } else {
      renderHistoryDayShell();
    }
  }

  // --- Ιστορικό: Ημέρα ---------------------------------------------------

  function renderHistoryDayShell() {
    content.innerHTML = `
      ${subTabsHTML()}
      <div class="card date-picker-card">
        <label class="date-picker-label" for="history-date-input">Επιλογή ημερομηνίας</label>
        <div class="date-picker-row">
          <input type="date" id="history-date-input" value="${state.historyDayYMD}" min="${state.bounds.min}" max="${state.bounds.max}">
          <button type="button" class="secondary-button" id="history-today-button">Σήμερα</button>
        </div>
      </div>
      <div id="history-day-content"></div>`;

    attachSubTabHandlers();

    const input = document.getElementById("history-date-input");
    input.addEventListener("change", () => {
      if (!input.value) return;
      const clamped = clampYMD(input.value, state.bounds.min, state.bounds.max);
      if (clamped !== input.value) input.value = clamped;
      state.historyDayYMD = clamped;
      loadHistoryDay(clamped);
    });

    document.getElementById("history-today-button").addEventListener("click", () => {
      const clamped = clampYMD(todayYMD(), state.bounds.min, state.bounds.max);
      input.value = clamped;
      state.historyDayYMD = clamped;
      loadHistoryDay(clamped);
    });

    loadHistoryDay(state.historyDayYMD);
  }

  async function loadHistoryDay(ymdValue) {
    const container = document.getElementById("history-day-content");
    if (!container) return;
    showLoading(container);
    setRefreshing(true);

    const isCurrent = () =>
      state.tab === "history" && state.historyMode === "day" && state.historyDayYMD === ymdValue;

    try {
      let periods = dayCache.get(ymdValue);
      if (!periods) {
        periods = await fetchDayRows(ymdValue);
        dayCache.set(ymdValue, periods);
      }
      if (!isCurrent()) return;

      const isTomorrow = ymdValue === addDaysYMD(todayYMD(), 1);
      if (isTomorrow && periods.length < CONFIG.minPeriodsForPublished) {
        showTomorrowPending(container);
        return;
      }
      if (periods.length === 0) {
        showEmpty(container, "history");
        return;
      }
      showDayDetail(container, ymdValue, periods);
    } catch (error) {
      if (!isCurrent()) return;
      showError(container, error, () => loadHistoryDay(ymdValue));
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }

  // --- Ιστορικό: Μήνας -----------------------------------------------------

  function renderHistoryMonthShell() {
    content.innerHTML = `
      ${subTabsHTML()}
      <div class="card month-picker-card">
        <div class="month-picker-row">
          <button type="button" class="icon-button icon-button--small" id="month-prev" aria-label="Προηγούμενος μήνας">‹</button>
          <div class="month-selects">
            <select id="month-select" aria-label="Μήνας"></select>
            <select id="year-select" aria-label="Έτος"></select>
          </div>
          <button type="button" class="icon-button icon-button--small" id="month-next" aria-label="Επόμενος μήνας">›</button>
        </div>
        <button type="button" class="secondary-button" id="month-current-button">Τρέχων μήνας</button>
      </div>
      <div id="history-month-content"></div>`;

    attachSubTabHandlers();
    populateMonthYearSelects();

    document.getElementById("month-select").addEventListener("change", onMonthYearSelectChange);
    document.getElementById("year-select").addEventListener("change", onMonthYearSelectChange);
    document.getElementById("month-prev").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("month-next").addEventListener("click", () => shiftMonth(1));
    document.getElementById("month-current-button").addEventListener("click", () => {
      const t = parseYMD(todayYMD());
      setHistoryMonth(t.year, t.month);
    });

    loadHistoryMonth(state.historyYear, state.historyMonth);
  }

  function populateMonthYearSelects() {
    const monthSelect = document.getElementById("month-select");
    monthSelect.innerHTML = GREEK_MONTHS
      .map((name, index) => `<option value="${index + 1}">${name}</option>`)
      .join("");
    monthSelect.value = String(state.historyMonth);

    const minYear = parseYMD(state.bounds.min).year;
    const maxYear = parseYMD(state.bounds.max).year;
    const yearSelect = document.getElementById("year-select");
    const years = [];
    for (let y = maxYear; y >= minYear; y--) years.push(y);
    yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    yearSelect.value = String(state.historyYear);

    updateMonthNavDisabled();
  }

  function updateMonthNavDisabled() {
    const prevButton = document.getElementById("month-prev");
    const nextButton = document.getElementById("month-next");
    if (!prevButton || !nextButton) return;
    const key = monthKey(state.historyYear, state.historyMonth);
    const minParsed = parseYMD(state.bounds.min);
    const maxParsed = parseYMD(state.bounds.max);
    prevButton.disabled = key <= monthKey(minParsed.year, minParsed.month);
    nextButton.disabled = key >= monthKey(maxParsed.year, maxParsed.month);
  }

  function onMonthYearSelectChange() {
    const month = Number(document.getElementById("month-select").value);
    const year = Number(document.getElementById("year-select").value);
    setHistoryMonth(year, month);
  }

  function shiftMonth(delta) {
    let { year, month } = { year: state.historyYear, month: state.historyMonth };
    month += delta;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    setHistoryMonth(year, month);
  }

  function setHistoryMonth(year, month) {
    const minKey = monthKey(parseYMD(state.bounds.min).year, parseYMD(state.bounds.min).month);
    const maxKey = monthKey(parseYMD(state.bounds.max).year, parseYMD(state.bounds.max).month);
    let key = monthKey(year, month);
    if (key < minKey) { ({ year, month } = parseYMD(state.bounds.min)); key = minKey; }
    if (key > maxKey) { ({ year, month } = parseYMD(state.bounds.max)); key = maxKey; }

    state.historyYear = year;
    state.historyMonth = month;

    const monthSelect = document.getElementById("month-select");
    const yearSelect = document.getElementById("year-select");
    if (monthSelect) monthSelect.value = String(month);
    if (yearSelect) yearSelect.value = String(year);
    updateMonthNavDisabled();

    loadHistoryMonth(year, month);
  }

  async function loadHistoryMonth(year, month) {
    const container = document.getElementById("history-month-content");
    if (!container) return;
    showLoading(container);
    setRefreshing(true);

    const key = monthKey(year, month);
    const isCurrent = () =>
      state.tab === "history" &&
      state.historyMode === "month" &&
      state.historyYear === year &&
      state.historyMonth === month;

    try {
      let periodsByDay = monthCache.get(key);
      if (!periodsByDay) {
        const rows = await fetchMonthRows(year, month);
        periodsByDay = groupByDeliveryDate(rows);
        monthCache.set(key, periodsByDay);
      }
      if (!isCurrent()) return;
      renderMonthContent(container, year, month, periodsByDay);
    } catch (error) {
      if (!isCurrent()) return;
      showError(container, error, () => {
        monthCache.delete(key);
        loadHistoryMonth(year, month);
      });
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }

  function renderMonthContent(container, year, month, periodsByDay) {
    const stats = computeMonthlyStatistics(periodsByDay);
    const totalDays = daysInMonth(year, month);
    const cards = [];

    for (let day = 1; day <= totalDays; day++) {
      const dateStr = ymd(year, month, day);
      if (compareYMD(dateStr, state.bounds.max) > 0) break; // δεν έχουν φτάσει ακόμη δεδομένα
      if (compareYMD(dateStr, state.bounds.min) < 0) continue;
      cards.push(dayCardHTML(dateStr, periodsByDay.get(dateStr)));
    }

    container.innerHTML = `
      <div class="stack">
        ${monthlyStatsHTML(year, month, stats)}
        <section class="card">
          <h2 class="section-title">Ημέρες του μήνα</h2>
          <div class="day-list">
            ${cards.join("") || `<p class="state__message">Δεν υπάρχουν διαθέσιμες ημέρες.</p>`}
          </div>
        </section>
      </div>`;

    container.querySelectorAll(".day-card[data-date]").forEach((el) => {
      el.addEventListener("click", () => {
        const date = el.dataset.date;
        state.historyMode = "day";
        state.historyDayYMD = date;
        const parsed = parseYMD(date);
        state.historyYear = parsed.year;
        state.historyMonth = parsed.month;
        renderHistory();
      });
    });
  }

  function dayCardHTML(dateStr, periods) {
    if (!periods || periods.length === 0) {
      return `
        <button type="button" class="day-card day-card--missing" data-date="${dateStr}">
          <span class="day-card__date">${formatDayShort(dateStr)}</span>
          <span class="day-card__missing">Χωρίς δεδομένα</span>
        </button>`;
    }

    const summary = summarize(periods);
    const badges = [];
    if (summary.negativeCount > 0) badges.push(`<span class="day-badge day-badge--negative">Αρνητική</span>`);
    if (summary.zeroCount > 0) badges.push(`<span class="day-badge day-badge--zero">Μηδενική</span>`);
    const tone = summary.negativeCount > 0 ? "day-card--negative" : summary.zeroCount > 0 ? "day-card--zero" : "";

    return `
      <button type="button" class="day-card ${tone}" data-date="${dateStr}">
        <div class="day-card__top">
          <span class="day-card__date">${formatDayShort(dateStr)}</span>
          <div class="day-card__badges">${badges.join("")}</div>
        </div>
        <div class="day-card__stats">
          <div class="day-card__stat">
            <span class="day-card__stat-label">Μέση</span>
            <span class="day-card__stat-value">${formatPrice(summary.average)}</span>
          </div>
          <div class="day-card__stat">
            <span class="day-card__stat-label">Ελάχιστη</span>
            <span class="day-card__stat-value ${priceStatusClass(summary.minimum)}">${formatPrice(summary.minimum)}</span>
          </div>
          <div class="day-card__stat">
            <span class="day-card__stat-label">Μέγιστη</span>
            <span class="day-card__stat-value">${formatPrice(summary.maximum)}</span>
          </div>
        </div>
      </button>`;
  }

  function monthlyStatsHTML(year, month, stats) {
    const monthLabel = `${GREEK_MONTHS[month - 1]} ${year}`;
    const streak = stats.longestNegative;
    const streakValue = streak ? formatDuration(streak.durationMinutes) : "Καμία";
    const streakDetail = streak
      ? `${formatDayShort(streak.day)} · ${formatTime(streak.startTime)}–${formatTime(streak.endTime)}`
      : "Χωρίς αρνητική ακολουθία";

    const minObs = stats.minObservation;
    const maxObs = stats.maxObservation;
    const minDetail = minObs ? `${formatDayShort(minObs.day)} · ${formatTime(minObs.startTime)}` : null;
    const maxDetail = maxObs ? `${formatDayShort(maxObs.day)} · ${formatTime(maxObs.startTime)}` : null;

    return `
      <section class="card">
        <h2 class="section-title">Στατιστικά μήνα — ${monthLabel}</h2>
        <div class="stats-grid">
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">➖</span> Ημέρες με αρνητικές τιμές</span>
            <span class="metric-card__value ${stats.negativeDayCount > 0 ? "is-negative" : ""}">${stats.negativeDayCount}</span>
            <span class="metric-card__detail">${formatDuration(stats.negativeMinutes)} συνολικά</span>
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">⭘</span> Ημέρες με μηδενικές τιμές</span>
            <span class="metric-card__value">${stats.zeroDayCount}</span>
            <span class="metric-card__detail">${formatDuration(stats.zeroMinutes)} συνολικά</span>
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">📉</span> Μεγαλύτερη αρνητική ακολουθία</span>
            <span class="metric-card__value ${streak ? "is-negative" : ""}">${streakValue}</span>
            <span class="metric-card__detail">${streakDetail}</span>
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">Σ</span> Μέση τιμή μήνα</span>
            <span class="metric-card__value">${stats.averagePrice != null ? `${formatPrice(stats.averagePrice)} €/MWh` : "—"}</span>
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">⬇</span> Ελάχιστη τιμή μήνα</span>
            <span class="metric-card__value ${minObs && minObs.price < 0 ? "is-negative" : ""}">${minObs ? `${formatPrice(minObs.price)} €/MWh` : "—"}</span>
            ${minDetail ? `<span class="metric-card__detail">${minDetail}</span>` : ""}
          </div>
          <div class="metric-card">
            <span class="metric-card__title"><span aria-hidden="true">⬆</span> Μέγιστη τιμή μήνα</span>
            <span class="metric-card__value">${maxObs ? `${formatPrice(maxObs.price)} €/MWh` : "—"}</span>
            ${maxDetail ? `<span class="metric-card__detail">${maxDetail}</span>` : ""}
          </div>
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------------
  // 7. Καλωδίωση UI
  // ---------------------------------------------------------------------

  const content = document.getElementById("content");
  const tabButtons = Array.from(document.querySelectorAll(".tab"));
  const refreshButton = document.getElementById("refresh-button");

  const state = {
    tab: "today", // 'today' | 'tomorrow' | 'history'
    historyMode: "day", // 'day' | 'month'
    historyDayYMD: null,
    historyYear: null,
    historyMonth: null,
    bounds: null, // { min, max } — γεμίζει με fetchDateBounds()
  };

  function setActiveTabButton(activeButton) {
    tabButtons.forEach((b) => {
      b.classList.toggle("is-active", b === activeButton);
      b.setAttribute("aria-selected", b === activeButton ? "true" : "false");
    });
  }

  function setRefreshing(isLoading) {
    refreshButton.classList.toggle("is-loading", isLoading);
    refreshButton.disabled = isLoading;
  }

  async function loadDay(tab, { force = false } = {}) {
    state.tab = tab;
    const ymdValue = tab === "today" ? todayYMD() : addDaysYMD(todayYMD(), 1);
    showLoading(content);
    setRefreshing(true);

    try {
      let periods = dayCache.get(ymdValue);
      if (!periods || force) {
        periods = await fetchDayRows(ymdValue);
        dayCache.set(ymdValue, periods);
      }
      if (state.tab !== tab) return;

      if (tab === "tomorrow" && periods.length < CONFIG.minPeriodsForPublished) {
        showTomorrowPending(content);
        return;
      }
      if (periods.length === 0) {
        showEmpty(content, tab);
        return;
      }
      showDayDetail(content, ymdValue, periods);
    } catch (error) {
      if (state.tab !== tab) return;
      showError(content, error, () => loadDay(tab, { force: true }));
    } finally {
      if (state.tab === tab) setRefreshing(false);
    }
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.day;
      if (tab === state.tab) return;
      setActiveTabButton(button);
      if (tab === "history") {
        state.tab = "history";
        enterHistory();
      } else {
        loadDay(tab);
      }
    });
  });

  refreshButton.addEventListener("click", () => {
    if (state.tab === "history") {
      if (state.historyMode === "day") {
        dayCache.delete(state.historyDayYMD);
        loadHistoryDay(state.historyDayYMD);
      } else {
        monthCache.delete(monthKey(state.historyYear, state.historyMonth));
        loadHistoryMonth(state.historyYear, state.historyMonth);
      }
    } else {
      loadDay(state.tab, { force: true });
    }
  });

  // Ξαναζωγραφίζει την τρέχουσα περίοδο κάθε λεπτό χωρίς νέο αίτημα δικτύου,
  // ώστε η ένδειξη «τώρα» να παραμένει σωστή όσο η σελίδα μένει ανοιχτή.
  setInterval(() => {
    const ymdNow = todayYMD();
    if (state.tab === "today" && dayCache.has(ymdNow)) {
      showDayDetail(content, ymdNow, dayCache.get(ymdNow));
    } else if (state.tab === "history" && state.historyMode === "day" && state.historyDayYMD === ymdNow) {
      const container = document.getElementById("history-day-content");
      if (container && dayCache.has(ymdNow)) showDayDetail(container, ymdNow, dayCache.get(ymdNow));
    }
  }, 60_000);

  loadDay("today");
})();
