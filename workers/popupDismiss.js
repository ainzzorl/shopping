// Dismiss cookie banners and popups so they don't block the screenshot.
// Conservative: only clicks close-icons and known consent buttons; never
// generic "Continue"/"OK" text that could be a checkout action.
async function dismissPopups(page) {
  try {
    await page.keyboard.press("Escape");
  } catch (_) {}

  try {
    await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        const style = getComputedStyle(el);
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0"
        );
      };

      const click = (el) => {
        try { el.click(); } catch (_) {}
      };

      // Known consent / banner buttons — single-purpose, safe to click.
      const knownSelectors = [
        "#onetrust-accept-btn-handler",
        "#onetrust-close-btn-container button",
        "#CybotCookiebotDialogBodyButtonAccept",
        "#CybotCookiebotDialogBodyLevelButtonAccept",
        "#CybotCookiebotDialogBodyButtonDecline",
        "#truste-consent-button",
        ".cc-accept-all",
        ".cookie-accept",
        ".cookie-consent-accept",
        ".evidon-banner-acceptbutton",
        "#hs-eu-confirmation-button",
      ];
      for (const sel of knownSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (isVisible(el)) click(el);
        });
      }

      // Generic close-icon selectors — aria/title/class patterns.
      const closeSelectors = [
        '[aria-label="Close" i]',
        '[aria-label*="close" i]',
        '[aria-label*="dismiss" i]',
        '[title="Close" i]',
        '[title*="close" i]',
        "button.close",
        "button.modal-close",
        "button.popup-close",
        '[data-dismiss="modal"]',
        '[data-testid*="close" i]',
        '[data-testid*="dismiss" i]',
      ];
      for (const sel of closeSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (isVisible(el)) click(el);
        });
      }
    });
  } catch (_) {}
}

module.exports = { dismissPopups };
