import scrollama from 'scrollama';

export function scrollController() {
  const scroller = scrollama();

  function mixBackground({ element }) {
    document.querySelector('body').dataset.theme = element.dataset.themeset;
  }

  scroller
    .setup({
      step: '[data-themeset]',
      threshhold: 0,
      offset: 0.8,
    })
    .onStepEnter(mixBackground);
}

export function fadeController() {
  const fadeInScroller = scrollama();
  const fadeInUpScroller = scrollama();

  function handleFadeIn({ element }) {
    element.classList.add('in-view');
  }

  fadeInScroller
    .setup({
      step: '.fade-in',
      offset: 0.9,
      once: true,
    })
    .onStepEnter(handleFadeIn);

  fadeInUpScroller
    .setup({
      step: '.fade-in',
      offset: 0.1,
    })
    .onStepEnter(handleFadeIn);
}
