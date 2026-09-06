import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function build() {
  const artifactDir = "/Users/dmarinangeli/.gemini/antigravity/brain/be33de22-c501-40d5-9e30-4955e93d6d2d";
  const manPath = path.join(artifactDir, "autumn_man_clean_1788438495976.jpg");
  const womanPath = path.join(artifactDir, "autumn_clean_macro_1788438472475.jpg");

  const manB64 = (await sharp(manPath).resize(640).jpeg({ quality: 84 }).toBuffer()).toString("base64");
  const womanB64 = (await sharp(womanPath).resize(640).jpeg({ quality: 84 }).toBuffer()).toString("base64");

  const stylesCss = await readFile("/Volumes/ExtremeSSD/Wardrobbing/wardrobe/src/styles.css", "utf8");
  const colorProfileCss = await readFile("/Volumes/ExtremeSSD/Wardrobbing/wardrobe/src/color-profile.css", "utf8");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Colors — Native Side Panel Harmony</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
  <style>
${stylesCss}
${colorProfileCss}

  /* Override fixed overlay positioning for clean standalone prototype embedding */
  body {
    margin: 0;
    padding: 0;
    min-height: 100vh;
    background: var(--paper);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    box-sizing: border-box;
  }

  .viewer-overlay.prototype-mode {
    position: relative;
    inset: auto;
    background: transparent;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    max-width: 480px;
    animation: none;
  }

  .viewer-entry.color-quiz-entry {
    animation: none;
    width: 100%;
    max-width: 460px;
  }

  .viewer.has-modeled-image.color-viewer-panel {
    border-radius: var(--r-xl);
    border: 1px solid var(--glass-border);
    box-shadow: var(--shadow-lg);
  }
  </style>
</head>
<body>

  <div class="viewer-overlay prototype-mode" role="presentation">
    <div class="viewer-entry color-quiz-entry">
      <aside class="viewer has-modeled-image color-viewer-panel" role="dialog" aria-modal="true" aria-label="My Colors">
        
        <!-- Native circular close button -->
        <button class="icon-button viewer-icon-close" type="button" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
            <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path>
          </svg>
        </button>

        <!-- Modeled Hero: 16:9 Uncut Macro Photo -->
        <div class="modeled-hero">
          <img
            id="hero-img"
            class="modeled-hero-photo"
            src="data:image/jpeg;base64,${manB64}"
            alt="Autunno Deep editorial macro detail"
          />
        </div>

        <!-- Details Section: Strict Spacing Rhythm -->
        <div class="viewer-details editing color-viewer-details">
          
          <!-- Clean Title Row with Gender Switcher -->
          <div class="color-title-row">
            <h2 class="color-season-title">Autunno Deep</h2>
            <div class="ai-mode-switch__pill" role="radiogroup" aria-label="Reference model presentation">
              <button id="btn-man" type="button" class="active" onclick="setGender('man')">Man</button>
              <button id="btn-woman" type="button" class="" onclick="setGender('woman')">Woman</button>
            </div>
          </div>

          <p class="color-season-description">
            Deep Autumn's rich, grounded tones complement your natural warmth, dark espresso hair and warm chestnut eyes.
          </p>

          <!-- Natural Pigments -->
          <div class="color-details-section">
            <p class="details-label">Natural Pigments</p>
            <div class="color-pigments-row">
              <span class="color-pigment-chip" title="#D2A58D">
                <span class="color-pigment-dot" style="background-color: #D2A58D;"></span>
                Skin: Neutral Warm Beige
              </span>
              <span class="color-pigment-chip" title="#4E2E1A">
                <span class="color-pigment-dot" style="background-color: #4E2E1A;"></span>
                Eyes: Chestnut Brown
              </span>
              <span class="color-pigment-chip" title="#2B201A">
                <span class="color-pigment-dot" style="background-color: #2B201A;"></span>
                Hair: Dark Espresso
              </span>
            </div>
          </div>

          <!-- Signature Palette Editor -->
          <div class="color-details-section">
            <div class="color-palette-editor">
              <div class="color-palette-heading">
                <p class="details-label">Signature Palette (8)</p>
                <button type="button" class="color-extract-btn">+ Extract from photo</button>
              </div>
              <div class="palette-swatches">
                <span class="palette-swatch" style="background-color: #2D4739;" title="#2D4739"></span>
                <span class="palette-swatch" style="background-color: #9E472A;" title="#9E472A"></span>
                <span class="palette-swatch" style="background-color: #C08A3E;" title="#C08A3E"></span>
                <span class="palette-swatch" style="background-color: #1A535C;" title="#1A535C"></span>
                <span class="palette-swatch" style="background-color: #5C1D24;" title="#5C1D24"></span>
                <span class="palette-swatch" style="background-color: #556B2F;" title="#556B2F"></span>
                <span class="palette-swatch" style="background-color: #3B2319;" title="#3B2319"></span>
                <span class="palette-swatch" style="background-color: #E6D7C3;" title="#E6D7C3"></span>
              </div>
            </div>
          </div>

          <!-- Match Toggle -->
          <label class="palette-toggle">
            <input type="checkbox" checked />
            <span>Show seasonal match badges on wardrobe pieces</span>
          </label>

          <!-- Auxiliary Actions (Canonical .secondary-button primitive) -->
          <div class="color-auxiliary-actions">
            <button class="secondary-button" type="button">
              <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
                <path d="M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8H80a8,8,0,0,0,6.66-3.56L100.29,48h55.42l13.63,20.44A8,8,0,0,0,176,72h32a8,8,0,0,1,8,8ZM128,88a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,88Zm0,72a28,28,0,1,1,28-28A28,28,0,0,1,128,160Z"></path>
              </svg>
              Change face photo
            </button>
            <button class="secondary-button" type="button">
              <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
                <path d="M140,180a12,12,0,1,1-12-12A12,12,0,0,1,140,180ZM128,72c-22.06,0-40,16.15-40,36a8,8,0,0,0,16,0c0-11,10.77-20,24-20s24,9,24,20c0,9.15-6.52,14.65-15.69,21.73C124.93,138.45,120,143.51,120,152a8,8,0,0,0,16,0c0-4.09,2.69-7.38,9.7-12.78C156.46,130.82,168,121.71,168,108,168,88.15,150.06,72,128,72Z"></path>
              </svg>
              Fine-tune with quiz
            </button>
          </div>

          <!-- PanelActions Footer (Standard Cancel & Save) -->
          <div class="viewer-actions">
            <span class="action-spacer"></span>
            <button class="secondary-button" type="button">Cancel</button>
            <button class="primary-button" type="button">
              <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor">
                <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path>
              </svg>
              Save Profile
            </button>
          </div>

        </div>
      </aside>
    </div>
  </div>

  <script>
    let currentGender = 'man';
    const manImg = "data:image/jpeg;base64,${manB64}";
    const womanImg = "data:image/jpeg;base64,${womanB64}";

    function setGender(gender) {
      currentGender = gender;
      document.getElementById('hero-img').src = gender === 'man' ? manImg : womanImg;
      document.getElementById('btn-man').className = gender === 'man' ? 'active' : '';
      document.getElementById('btn-woman').className = gender === 'woman' ? 'active' : '';
    }
  </script>
</body>
</html>`;

  await writeFile(path.join(artifactDir, "color_prototypes.html"), html, "utf8");
  await writeFile("/Volumes/ExtremeSSD/Wardrobbing/wardrobe/prototypes-preview.html", html, "utf8");
  console.log("Updated native side panel preview HTML!");
}

build();
