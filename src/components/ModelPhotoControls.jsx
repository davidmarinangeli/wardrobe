import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretDown, CaretUp, Check, SpinnerGap, X } from "@phosphor-icons/react";
import { modelTiers } from "../model-tiers.js";
import { MODEL_TIER_STORAGE_KEY, resolveModelTier } from "../item-sheet.js";
import { moveMenuFocus, useDismissOnOutsidePointer } from "../hooks/usePopover.js";

// The controls every panel uses to make an image — the item sheet's model
// photo, an outfit's model photo, detecting the pieces in an inspo pin. One
// visual rule across all three: making something for the first time is the
// accent pill; doing it again is a quieter glass chip.

function readStoredTier() {
  try {
    return window.localStorage.getItem(MODEL_TIER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * One quality choice, remembered between sheets and shared by every panel that
 * generates — choosing Premium for an outfit is choosing it for the next item
 * too, the same as it would be in any other app's settings.
 */
export function useRememberedTier(provider, premiumAllowed) {
  const tiers = modelTiers(provider);
  const [stored, setStored] = useState(readStoredTier);
  const tier = resolveModelTier(stored, tiers, premiumAllowed);
  const chooseTier = useCallback((next) => {
    setStored(next);
    try {
      window.localStorage.setItem(MODEL_TIER_STORAGE_KEY, next);
    } catch {
      // Storage refused (private browsing): the choice still holds for this panel.
    }
  }, []);
  return { tier, tiers, chooseTier };
}

/**
 * One action, its quality behind a caret — the split-button shape of GitHub's
 * "Merge ▾". Without `tiers` it is the same pill with no caret, for actions
 * that have no quality to choose (detecting the pieces in a pin).
 */
export function GenerateButton({ icon, label, busy = false, busyLabel = "Starting…", disabled = false, onGenerate, tier, tiers = null, onTierChange, premiumAllowed = true, block = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const tierButtonRef = useRef(null);
  const hasTiers = Boolean(tiers?.length);
  const current = hasTiers ? tiers.find((option) => option.id === tier) || tiers[0] : null;
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePointer(open, rootRef, close);

  useEffect(() => {
    if (open) menuRef.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open]);

  const choose = (id) => {
    onTierChange(id);
    setOpen(false);
    tierButtonRef.current?.focus({ preventScroll: true });
  };

  return (
    <div ref={rootRef} className={`generate-button${block ? " generate-button--block" : ""}`}>
      <div className="generate-button__pill">
        <button type="button" className="generate-button__main" disabled={disabled || busy} onClick={() => onGenerate(tier)}>
          {busy ? <SpinnerGap size={16} className="modeled-photo-spinner" aria-hidden="true" /> : icon}
          {busy ? busyLabel : label}
        </button>
        {hasTiers && (
          <>
            <span className="generate-button__divider" aria-hidden="true" />
            <button
              ref={tierButtonRef}
              type="button"
              className="generate-button__tier"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`Quality: ${current?.label}. Change quality`}
              disabled={busy}
              onClick={() => setOpen((value) => !value)}
            >
              {current?.label}
              {open ? <CaretUp size={13} weight="bold" aria-hidden="true" /> : <CaretDown size={13} weight="bold" aria-hidden="true" />}
            </button>
          </>
        )}
      </div>
      {hasTiers && open && (
        <div
          ref={menuRef}
          className="tier-menu"
          role="menu"
          aria-label="Model photo quality"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              event.preventDefault();
              setOpen(false);
              tierButtonRef.current?.focus({ preventScroll: true });
              return;
            }
            moveMenuFocus(event, event.currentTarget);
          }}
        >
          <p className="tier-menu__title">Model photo quality</p>
          {tiers.map((option) => {
            const locked = option.id === "premium" && !premiumAllowed;
            const checked = option.id === tier;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                disabled={locked}
                className="tier-menu__option"
                onClick={() => choose(option.id)}
              >
                <span className="tier-menu__text">
                  <span>{option.label}</span>
                  <small>{locked ? "Needs PROD mode" : [option.model, option.note].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="tier-menu__price">{option.price || ""}</span>
                <span className="tier-menu__check" aria-hidden="true">{checked && <Check size={16} weight="bold" />}</span>
              </button>
            );
          })}
          <p className="tier-menu__foot">
            {tiers.some((option) => option.price) ? "Per photo, approximate. " : ""}Your choice is remembered for next time.
          </p>
        </div>
      )}
    </div>
  );
}

/** What is being made, shown where it will appear. */
export function StageStatus({ children }) {
  return (
    <span className="stage-status" role="status">
      <SpinnerGap size={15} className="modeled-photo-spinner" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Doing it again: a glass chip, quieter than the accent pill that did it first.
 * `concealed` hides it without unmounting — while the composer it opened is
 * showing, it is still the shape that composer grows from and shrinks back to.
 */
export function StageChip({ ref, icon, label, onClick, disabled = false, concealed = false }) {
  return (
    <button
      ref={ref}
      type="button"
      className={`stage-chip${concealed ? " is-concealed" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-hidden={concealed || undefined}
      inert={concealed}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Another go at a model photo, with a note on what to change — composed on the
 * photo itself, where the thing being described is still in view.
 *
 * It grows out of whatever opened it: `originRef` names that element (the
 * "Refine photo" chip), and the composer starts clipped to exactly its
 * footprint, then opens out to full size; closing runs the same path back.
 * Without an origin it grows from a chip-sized slot at the bottom centre.
 * Always mounted so the close can animate — `inert` and hidden while closed.
 */
export function RefineComposer({ open, onClose, originRef, note, onNoteChange, busy, onGenerate, tier, tiers, onTierChange, premiumAllowed }) {
  const rootRef = useRef(null);
  const surfaceRef = useRef(null);
  const inputRef = useRef(null);
  const inputId = useId();

  // `data-open` is driven here rather than through render, so it can be
  // preceded by a style flush: a transition starts from the style of the
  // previous frame, and the surface has to *start* at the chip.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    if (open) {
      const surface = surfaceRef.current;
      const origin = originRef?.current?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      // Snap the closed surface onto the measured chip with transitions off.
      // Left on, moving the closed clip would itself start a transition, and
      // opening would then set off from that transition's first frame — the
      // old shape — instead of from the chip.
      surface.style.transition = "none";
      if (origin && origin.width && box.width) {
        element.style.setProperty("--from-top", `${origin.top - box.top}px`);
        element.style.setProperty("--from-right", `${box.right - origin.right}px`);
        element.style.setProperty("--from-bottom", `${box.bottom - origin.bottom}px`);
        element.style.setProperty("--from-left", `${origin.left - box.left}px`);
        element.style.setProperty("--from-radius", `${origin.height / 2}px`);
      }
      void getComputedStyle(surface).clipPath;
      surface.style.transition = "";
      void getComputedStyle(surface).clipPath;
      element.setAttribute("data-open", "");
      inputRef.current?.focus({ preventScroll: true });
    } else {
      // Closing makes the composer inert, which drops focus on the floor; give
      // it back to the chip it folds into.
      const hadFocus = element.contains(document.activeElement) || document.activeElement === document.body;
      element.removeAttribute("data-open");
      if (hadFocus && element.hasAttribute("data-was-open")) originRef?.current?.focus({ preventScroll: true });
    }
    if (open) element.setAttribute("data-was-open", "");
  }, [open, originRef]);

  return (
    <div
      ref={rootRef}
      className="refine-composer"
      role="group"
      aria-label="Refine model photo"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }}
    >
      {/* The glass that grows out of the chip. A real element rather than a
          ::before: Chrome doesn't recompute a pseudo-element's style on a
          forced flush, which left the grow starting from a stale shape. */}
      <span ref={surfaceRef} className="refine-composer__surface" aria-hidden="true" />
      <div className="refine-composer__body">
        <div className="refine-composer__head">
          <label className="refine-composer__label" htmlFor={inputId}>What should change?</label>
          <button type="button" className="refine-composer__close" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={15} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          className="refine-composer__input"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) {
              event.preventDefault();
              onGenerate(tier);
            }
          }}
          placeholder="e.g. jacket should be darker"
          enterKeyHint="go"
          disabled={busy}
        />
        <GenerateButton
          block
          icon={<RegenerateIcon />}
          label="Regenerate"
          busy={busy}
          onGenerate={onGenerate}
          tier={tier}
          tiers={tiers}
          onTierChange={onTierChange}
          premiumAllowed={premiumAllowed}
        />
      </div>
    </div>
  );
}

function RegenerateIcon() {
  return <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" />;
}
