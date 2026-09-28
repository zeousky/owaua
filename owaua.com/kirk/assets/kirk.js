'use strict';

function start() {
  const drawer = document.querySelector('.drawer');
  const mobileDrawer = window.matchMedia('(max-width: 860px)');
  if (drawer) {
    function fitDrawer() {
      drawer.open = !mobileDrawer.matches;
    }
    mobileDrawer.addEventListener('change', fitDrawer);
    drawer.addEventListener('click', event => {
      if (!mobileDrawer.matches) return;
      if (event.target.closest('a')) drawer.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drawer.open && mobileDrawer.matches) {
        drawer.open = false;
        drawer.querySelector('summary').focus();
      }
    });
  }

  for (const button of document.querySelectorAll('[data-secret-button]')) {
    button.addEventListener('click', event => {
      if (button.classList.contains('is-revealed')) return;
      event.preventDefault();
      event.stopPropagation();
      button.textContent = 'secret button';
      button.setAttribute('aria-label', 'secret button');
      button.classList.add('is-revealed');
    });
  }

  const contactLinks = document.querySelectorAll('.contact-link[data-contact-email]');
  if (contactLinks.length) {
    const status = document.createElement('div');
    status.className = 'contact-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.append(status);

    let statusTimer;
    for (const link of contactLinks) {
      link.addEventListener('click', () => {
        const email = link.dataset.contactEmail;
        status.textContent = `Email address: ${email}`;
        status.classList.add('visible');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => status.classList.remove('visible'), 7000);
        if (!navigator.clipboard?.writeText) return;
        navigator.clipboard.writeText(email).then(() => {
          status.textContent = `Email address copied: ${email}`;
        }).catch(() => {});
      });
    }
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
