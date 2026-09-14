# Energy Price Monitor — Web

Απλή, στατική ιστοσελίδα (HTML/CSS/vanilla JavaScript, χωρίς build step) που
δείχνει τις τιμές χονδρικής αγοράς ρεύματος Ελλάδας, μέσω του ίδιου Supabase
backend με το iOS app "Energy Price Monitor".

Καμία κλήση προς το ENTSO-E γίνεται από τον browser — μόνο ανάγνωση (SELECT)
του πίνακα `prices` στο Supabase μέσω PostgREST, με το δημόσιο "publishable"
key. Η λήψη από το ENTSO-E γίνεται μία φορά την ημέρα από μια Supabase Edge
Function, εκτός αυτής της σελίδας.

## Αρχεία

- `index.html` — δομή σελίδας
- `styles.css` — dark theme, τιρκουάζ accent
- `script.js` — φόρτωση δεδομένων, υπολογισμοί, γράφημα (Chart.js από CDN)

Δεν υπάρχει `package.json`, bundler ή build step. Το GitHub Pages σερβίρει τα
αρχεία όπως είναι.

## Ανάπτυξη (τοπικά)

Οποιοσδήποτε στατικός web server αρκεί, π.χ.:

```bash
python3 -m http.server 8000
```

και μετά άνοιγμα του `http://localhost:8000`.

## Ανέβασμα σε νέο GitHub repo + GitHub Pages

1. **Δημιούργησε νέο repository στο GitHub** (π.χ. `energy-price-web`),
   δημόσιο, χωρίς README/`.gitignore`/license (θα τα προσθέσουμε εμείς).

2. **Αρχικοποίησε το git εδώ και κάνε το πρώτο commit:**

   ```bash
   cd energy-price-web
   git init
   git add .
   git commit -m "Αρχική έκδοση στατικής σελίδας τιμών ρεύματος"
   git branch -M main
   ```

3. **Σύνδεσε το με το GitHub repo και ανέβασε:**

   ```bash
   git remote add origin https://github.com/<username>/energy-price-web.git
   git push -u origin main
   ```

4. **Ενεργοποίησε το GitHub Pages:**
   - Πήγαινε στο repo στο GitHub → **Settings** → **Pages**.
   - Στο **Source**, επίλεξε **Deploy from a branch**.
   - Branch: **main**, φάκελος: **/ (root)** → **Save**.
   - Μετά από 1-2 λεπτά, η σελίδα θα είναι διαθέσιμη στο
     `https://<username>.github.io/energy-price-web/`.

5. Κάθε επόμενο `git push` στο `main` ενημερώνει αυτόματα τη δημοσιευμένη
   σελίδα — δεν χρειάζεται κανένα άλλο βήμα.

## Σημείωση για το κλειδί Supabase

Το `sb_publishable_...` key μέσα στο `script.js` είναι το δημόσιο ("anon")
κλειδί — σχεδιασμένο να είναι ορατό σε client-side κώδικα, ίδιο με αυτό που
χρησιμοποιεί και το iOS app. Το πραγματικό όριο ασφαλείας είναι το Row Level
Security του πίνακα `prices` στο Supabase (δημόσιο SELECT, καμία policy για
write). Δεν χρειάζεται να το κρύψεις ή να το βάλεις σε μεταβλητή περιβάλλοντος.

## Πηγή δεδομένων

[ENTSO-E Transparency Platform](https://transparency.entsoe.eu/) (CC BY 4.0).
