document.documentElement.classList.add('js');
const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.16 });
  reveals.forEach((node) => observer.observe(node));
  window.setTimeout(() => reveals.forEach((node) => node.classList.add('is-visible')), 1400);
} else {
  reveals.forEach((node) => node.classList.add('is-visible'));
}
