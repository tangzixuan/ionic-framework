import { createGesture } from '@utils/gesture';
import { clamp, raf } from '@utils/helpers';

import type { Animation } from '../../../interface';
import type { GestureDetail } from '../../../utils/gesture';
import { getBackdropValueForSheet } from '../utils';

import { calculateSpringStep, handleCanDismiss } from './utils';

export interface MoveSheetToBreakpointOptions {
  /**
   * The breakpoint value to move the sheet to.
   */
  breakpoint: number;
  /**
   * The offset value between the current breakpoint and the new breakpoint.
   *
   * For breakpoint changes as a result of a touch gesture, this value
   * will be calculated internally.
   *
   * For breakpoint changes as a result of dynamically setting the value,
   * this value should be the difference between the new and old breakpoint.
   * For example:
   * - breakpoints: [0, 0.25, 0.5, 0.75, 1]
   * - Current breakpoint value is 1.
   * - Setting the breakpoint to 0.25.
   * - The offset value should be 0.75 (1 - 0.25).
   */
  breakpointOffset: number;
  /**
   * `true` if the sheet can be transitioned and dismissed off the view.
   */
  canDismiss?: boolean;

  /**
   * If `true`, the sheet will animate to the breakpoint.
   * If `false`, the sheet will jump directly to the breakpoint.
   */
  animated: boolean;
}

export const createSheetGesture = (
  baseEl: HTMLIonModalElement,
  backdropEl: HTMLIonBackdropElement,
  wrapperEl: HTMLElement,
  initialBreakpoint: number,
  backdropBreakpoint: number,
  animation: Animation,
  breakpoints: number[] = [],
  getCurrentBreakpoint: () => number,
  onDismiss: () => void,
  onBreakpointChange: (breakpoint: number) => void,
  prefersScrollingWhenScrolledToEdge: boolean
) => {
  // Defaults for the sheet swipe animation
  const defaultBackdrop = [
    { offset: 0, opacity: 'var(--backdrop-opacity)' },
    { offset: 1, opacity: 0.01 },
  ];

  const customBackdrop = [
    { offset: 0, opacity: 'var(--backdrop-opacity)' },
    { offset: 1 - backdropBreakpoint, opacity: 0 },
    { offset: 1, opacity: 0 },
  ];

  const SheetDefaults = {
    WRAPPER_KEYFRAMES: [
      { offset: 0, transform: 'translateY(0%)' },
      { offset: 1, transform: 'translateY(100%)' },
    ],
    BACKDROP_KEYFRAMES: backdropBreakpoint !== 0 ? customBackdrop : defaultBackdrop,
  };

  const contentEl = baseEl.querySelector('ion-content');
  const height = wrapperEl.clientHeight;
  let currentBreakpoint = initialBreakpoint;
  let offset = 0;
  let canDismissBlocksGesture = false;
  const canDismissMaxStep = 0.95;
  const wrapperAnimation = animation.childAnimations.find((ani) => ani.id === 'wrapperAnimation');
  const backdropAnimation = animation.childAnimations.find((ani) => ani.id === 'backdropAnimation');
  const maxBreakpoint = breakpoints[breakpoints.length - 1];
  const minBreakpoint = breakpoints[0];

  const enableBackdrop = () => {
    baseEl.style.setProperty('pointer-events', 'auto');
    backdropEl.style.setProperty('pointer-events', 'auto');

    /**
     * When the backdrop is enabled, elements such
     * as inputs should not be focusable outside
     * the sheet.
     */
    baseEl.classList.remove('ion-disable-focus-trap');
  };

  const disableBackdrop = () => {
    baseEl.style.setProperty('pointer-events', 'none');
    backdropEl.style.setProperty('pointer-events', 'none');

    /**
     * When the backdrop is enabled, elements such
     * as inputs should not be focusable outside
     * the sheet.
     * Adding this class disables focus trapping
     * for the sheet temporarily.
     */
    baseEl.classList.add('ion-disable-focus-trap');
  };

  /**
   * After the entering animation completes,
   * we need to set the animation to go from
   * offset 0 to offset 1 so that users can
   * swipe in any direction. We then set the
   * animation offset to the current breakpoint
   * so there is no flickering.
   */
  if (wrapperAnimation && backdropAnimation) {
    wrapperAnimation.keyframes([...SheetDefaults.WRAPPER_KEYFRAMES]);
    backdropAnimation.keyframes([...SheetDefaults.BACKDROP_KEYFRAMES]);
    animation.progressStart(true, 1 - currentBreakpoint);

    /**
     * If backdrop is not enabled, then content
     * behind modal should be clickable. To do this, we need
     * to remove pointer-events from ion-modal as a whole.
     * ion-backdrop and .modal-wrapper always have pointer-events: auto
     * applied, so the modal content can still be interacted with.
     */
    const shouldEnableBackdrop = currentBreakpoint > backdropBreakpoint;
    if (shouldEnableBackdrop) {
      enableBackdrop();
    } else {
      disableBackdrop();
    }
  }

  // Scroll should be disabled on smaller breakpoints when the user prefers scrolling when scrolled to edge
  // otherwise scrolling is enabled on all breakpoints
  if (contentEl && prefersScrollingWhenScrolledToEdge && currentBreakpoint !== maxBreakpoint) {
    contentEl.scrollY = false;
  }

  // If `prefersScrollingWhenScrolledToEdge` is false, we need to set the height of the ion-page to display all the content.
  // Otherwise, the content will be cut off at the bottom when the sheet is visible for the first time.
  if (!prefersScrollingWhenScrolledToEdge) {
    const transformSnapNumber = (1 - currentBreakpoint) * 100;
    console.log('transformSnapNumber', transformSnapNumber)
    const ionPageHeight = 100 - transformSnapNumber;
    const ionPage = baseEl.querySelector('.ion-page');
    // calc(100vh - 50% - 10px)
    // (ionPage as any).style.setProperty('height', `${ionPageHeight}%`);
    (ionPage as any).style.setProperty('height', `calc(100vh - ${transformSnapNumber}% - 10px)`);
  }

  const canStart = (detail: GestureDetail) => {
    /**
     * If the sheet is fully expanded and
     * `prefersScrollingWhenScrolledToEdge` is true and
     * the user is swiping on the content,
     * the gesture should not start to
     * allow for scrolling on the content.
     */
    const content = (detail.event.target! as HTMLElement).closest('ion-content');
    currentBreakpoint = getCurrentBreakpoint();

    if (prefersScrollingWhenScrolledToEdge && currentBreakpoint === 1 && content) {
      return false;
    }

    return true;
  };

  const onStart = () => {
    /**
     * If canDismiss is anything other than `true`
     * then users should be able to swipe down
     * until a threshold is hit. At that point,
     * the card modal should not proceed any further.
     *
     * canDismiss is never fired via gesture if there is
     * no 0 breakpoint. However, it can be fired if the user
     * presses Esc or the hardware back button.
     * TODO (FW-937)
     * Remove undefined check
     */
    canDismissBlocksGesture = baseEl.canDismiss !== undefined && baseEl.canDismiss !== true && minBreakpoint === 0;

    /**
     * If swiping on the content
     * we should disable scrolling otherwise
     * the sheet will expand and the content will scroll.
     */
    if (contentEl) {
      contentEl.scrollY = false;

      if (!prefersScrollingWhenScrolledToEdge) {
        // unset height to its initial value
        // This will be reset to 100% when it was assigned by
        // ion-modal > .ion-page { height: 100% }
        // This is necessary else the element will have
        // a lot of white space at the bottom
        const ionPage = baseEl.querySelector('.ion-page');
        (ionPage as any).style.removeProperty('height');
      }
    }

    raf(() => {
      /**
       * Dismisses the open keyboard when the sheet drag gesture is started.
       * Sets the focus onto the modal element.
       */
      baseEl.focus();
    });

    animation.progressStart(true, 1 - currentBreakpoint);
  };

  const onMove = (detail: GestureDetail) => {
    // console.log('onMove', detail)
    /**
     * Given the change in gesture position on the Y axis,
     * compute where the offset of the animation should be
     * relative to where the user dragged.
     */
    const initialStep = 1 - currentBreakpoint;
    const secondToLastBreakpoint = breakpoints.length > 1 ? 1 - breakpoints[1] : undefined;
    const step = initialStep + detail.deltaY / height;
    const isAttemptingDismissWithCanDismiss =
      secondToLastBreakpoint !== undefined && step >= secondToLastBreakpoint && canDismissBlocksGesture;

    /**
     * If we are blocking the gesture from dismissing,
     * set the max step value so that the sheet cannot be
     * completely hidden.
     */
    const maxStep = isAttemptingDismissWithCanDismiss ? canDismissMaxStep : 0.9999;

    /**
     * If we are blocking the gesture from
     * dismissing, calculate the spring modifier value
     * this will be added to the starting breakpoint
     * value to give the gesture a spring-like feeling.
     * Note that when isAttemptingDismissWithCanDismiss is true,
     * the modifier is always added to the breakpoint that
     * appears right after the 0 breakpoint.
     *
     * Note that this modifier is essentially the progression
     * between secondToLastBreakpoint and maxStep which is
     * why we subtract secondToLastBreakpoint. This lets us get
     * the result as a value from 0 to 1.
     */
    const processedStep =
      isAttemptingDismissWithCanDismiss && secondToLastBreakpoint !== undefined
        ? secondToLastBreakpoint +
          calculateSpringStep((step - secondToLastBreakpoint) / (maxStep - secondToLastBreakpoint))
        : step;

    offset = clamp(0.0001, processedStep, maxStep);
    animation.progressStep(offset);

    if (!prefersScrollingWhenScrolledToEdge) {
      const transformSnapNumber = (100 - (1 - processedStep) * 100);
      // console.log('transformSnapNumber', transformSnapNumber)
      const ionPageHeight = transformSnapNumber;
      const ionPage = baseEl.querySelector('.ion-page');
      // (ionPage as any).style.setProperty('height', `${ionPageHeight}%`);
      const ionPageClientHeight = (ionPage as any).clientHeight;

      const movingBreakpoint = (1 - processedStep) * 100;
      const minBreakpoint = Math.min((movingBreakpoint), 100);
      // (ionPage as any).style.setProperty('padding-bottom', `calc(${ionPageClientHeight}px - ${minBreakpoint}vh + 10px)`);
      (ionPage as any).style.setProperty('height', `calc(100vh - ${transformSnapNumber}% - 10px)`);
    }
  };

  const onEnd = (detail: GestureDetail) => {
    console.log('onEnd', detail)
    /**
     * When the gesture releases, we need to determine
     * the closest breakpoint to snap to.
     */
    const velocity = detail.velocityY;
    const threshold = (detail.deltaY + velocity * 350) / height;

    const diff = currentBreakpoint - threshold;
    const closest = breakpoints.reduce((a, b) => {
      return Math.abs(b - diff) < Math.abs(a - diff) ? b : a;
    });

    moveSheetToBreakpoint({
      breakpoint: closest,
      breakpointOffset: offset,
      canDismiss: canDismissBlocksGesture,

      /**
       * The swipe is user-driven, so we should
       * always animate when the gesture ends.
       */
      animated: true,
    });
  };

  const moveSheetToBreakpoint = (options: MoveSheetToBreakpointOptions) => {
    const { breakpoint, canDismiss, breakpointOffset, animated } = options;
    /**
     * canDismiss should only prevent snapping
     * when users are trying to dismiss. If canDismiss
     * is present but the user is trying to swipe upwards,
     * we should allow that to happen,
     */
    const shouldPreventDismiss = canDismiss && breakpoint === 0;
    const snapToBreakpoint = shouldPreventDismiss ? currentBreakpoint : breakpoint;

    const shouldRemainOpen = snapToBreakpoint !== 0;

    currentBreakpoint = 0;
    /**
     * Update the animation so that it plays from
     * the last offset to the closest snap point.
     */
    if (wrapperAnimation && backdropAnimation) {
      wrapperAnimation.keyframes([
        { offset: 0, transform: `translateY(${breakpointOffset * 100}%)` },
        { offset: 1, transform: `translateY(${(1 - snapToBreakpoint) * 100}%)` },
      ]);

      backdropAnimation.keyframes([
        {
          offset: 0,
          opacity: `calc(var(--backdrop-opacity) * ${getBackdropValueForSheet(
            1 - breakpointOffset,
            backdropBreakpoint
          )})`,
        },
        {
          offset: 1,
          opacity: `calc(var(--backdrop-opacity) * ${getBackdropValueForSheet(snapToBreakpoint, backdropBreakpoint)})`,
        },
      ]);

      animation.progressStep(0);
    }

    /**
     * Gesture should remain disabled until the
     * snapping animation completes.
     */
    gesture.enable(false);

    if (shouldPreventDismiss) {
      handleCanDismiss(baseEl, animation);
    } else if (!shouldRemainOpen) {
      onDismiss();
    }

    return new Promise<void>((resolve) => {
      animation
        .onFinish(
          () => {
            if (shouldRemainOpen) {
              /**
               * Once the snapping animation completes,
               * we need to reset the animation to go
               * from 0 to 1 so users can swipe in any direction.
               * We then set the animation offset to the current
               * breakpoint so that it starts at the snapped position.
               */
              if (wrapperAnimation && backdropAnimation) {
                raf(() => {
                  wrapperAnimation.keyframes([...SheetDefaults.WRAPPER_KEYFRAMES]);
                  backdropAnimation.keyframes([...SheetDefaults.BACKDROP_KEYFRAMES]);
                  animation.progressStart(true, 1 - snapToBreakpoint);
                  currentBreakpoint = snapToBreakpoint;
                  onBreakpointChange(currentBreakpoint);

                  /**
                   * If the sheet is fully expanded and `prefersScrollingWhenScrolledToEdge` is true, we can safely
                   * enable scrolling again.
                   * If `prefersScrollingWhenScrolledToEdge` is false, we can safely enable scrolling again regardless of the breakpoint.
                   */
                  if (contentEl && (currentBreakpoint === maxBreakpoint || !prefersScrollingWhenScrolledToEdge)) {
                    contentEl.scrollY = true;
                  }

                  // If `prefersScrollingWhenScrolledToEdge` is false, we need to set the height of the ion-page to display all the content.
                  if (!prefersScrollingWhenScrolledToEdge) {
                    const transformSnapNumber = (1 - snapToBreakpoint) * 100;
                    const ionPageHeight = 100 - transformSnapNumber;
                    const ionPage = baseEl.querySelector('.ion-page');
                    // remove padding-bottom
                    // (ionPage as any).style.removeProperty('padding-bottom');
                    // (ionPage as any).style.setProperty('height', `${snapToBreakpoint * 100}%`);
                    // console.log('snapToBreakpoint', snapToBreakpoint)
                    (ionPage as any).style.setProperty('height', `calc(100vh - ${transformSnapNumber}% - 10px)`);
                  }

                  /**
                   * Backdrop should become enabled
                   * after the backdropBreakpoint value
                   */
                  const shouldEnableBackdrop = currentBreakpoint > backdropBreakpoint;
                  if (shouldEnableBackdrop) {
                    enableBackdrop();
                  } else {
                    disableBackdrop();
                  }

                  gesture.enable(true);
                  resolve();
                });
              } else {
                gesture.enable(true);
                resolve();
              }
            } else {
              resolve();
            }

            /**
             * This must be a one time callback
             * otherwise a new callback will
             * be added every time onEnd runs.
             */
          },
          { oneTimeCallback: true }
        )
        .progressEnd(1, 0, animated ? 500 : 0);
    });
  };

  const gesture = createGesture({
    el: wrapperEl,
    gestureName: 'modalSheet',
    gesturePriority: 40,
    direction: 'y',
    threshold: 10,
    canStart,
    onStart,
    onMove,
    onEnd,
  });

  return {
    gesture,
    moveSheetToBreakpoint,
  };
};
