import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type ComposerPopoverRegistration = {
  container: RefObject<HTMLElement | null>;
  optionSelector: string;
};

type ComposerPopoverRegistrations<Menu extends string> = Record<Menu, ComposerPopoverRegistration>;

const OPENING_GESTURE_GUARD_MS = 200;

/**
 * Owns the shared interaction lifetime for the composer's mutually-exclusive
 * listbox popovers. Domain selection and option rendering stay with the caller.
 */
export function useComposerPopoverInteraction<Menu extends string>(
  registrations: ComposerPopoverRegistrations<Menu>,
) {
  const registrationsRef = useRef(registrations);
  registrationsRef.current = registrations;
  const [activeMenu, setActiveMenu] = useState<Menu | null>(null);
  const activeMenuRef = useRef<Menu | null>(null);
  const openingGuardUntilRef = useRef(0);

  const closeMenus = useCallback(() => {
    activeMenuRef.current = null;
    openingGuardUntilRef.current = 0;
    setActiveMenu(null);
  }, []);

  const toggleMenu = useCallback((menu: Menu) => {
    const next = activeMenuRef.current === menu ? null : menu;
    activeMenuRef.current = next;
    openingGuardUntilRef.current = next ? performance.now() + OPENING_GESTURE_GUARD_MS : 0;
    setActiveMenu(next);
  }, []);

  const pointerSelectionAllowed = useCallback(
    (menu: Menu) =>
      activeMenuRef.current === menu && performance.now() >= openingGuardUntilRef.current,
    [],
  );

  useEffect(() => {
    if (!activeMenu) return;
    const registration = registrationsRef.current[activeMenu];
    const optionButtons = () =>
      Array.from(
        registration.container.current?.querySelectorAll<HTMLButtonElement>(
          registration.optionSelector,
        ) ?? [],
      ).filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && registration.container.current?.contains(target)) return;
      event.preventDefault();
      closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus();
        return;
      }
      const options = optionButtons();
      if (options.length === 0) return;
      const index = options.findIndex((button) => button === document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next =
          index < 0
            ? delta > 0
              ? 0
              : options.length - 1
            : (index + delta + options.length) % options.length;
        options[next]?.focus();
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        options[event.key === "Home" ? 0 : options.length - 1]?.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        // Keyboard activation is deliberate and must not be rejected by the
        // opening-pointer guard used by option click handlers.
        openingGuardUntilRef.current = 0;
        options[index]?.click();
      }
    };
    // Attach after the opening gesture finishes so it cannot dismiss or select
    // through the popover that the same pointer event just mounted.
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeMenu, closeMenus]);

  return {
    activeMenu,
    closeMenus,
    isOpen: useCallback((menu: Menu) => activeMenu === menu, [activeMenu]),
    pointerSelectionAllowed,
    toggleMenu,
  };
}
