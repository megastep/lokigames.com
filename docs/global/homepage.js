const menus = ['products', 'orders', 'support', 'development', 'press', 'about', 'news'];
const routes = { products: 'products/', orders: 'orders/', support: 'support/', development: 'development/', press: 'press/', about: 'about/', news: 'news/' };
const menuElement = (name) => document.getElementById(`menu${name}`);
const setImage = (name, state) => {
  const image = document.images[name];
  if (image) image.src = `home/img/nav/${name}_${state}.gif`;
};
const setPortal = (name = '') => {
  const portal = document.images.portal;
  if (portal) portal.src = name ? `home/img/portal/${name}.gif` : 'home/img/portal/blank.gif';
};
const hideMenus = () => {
  for (const name of menus) {
    const menu = menuElement(name);
    if (menu) menu.style.visibility = 'hidden';
    setImage(name, 'off');
  }
  const back = document.getElementById('menuback');
  if (back) back.style.visibility = 'hidden';
  setPortal();
};
const showMenu = (name) => {
  hideMenus();
  const menu = menuElement(name);
  const back = document.getElementById('menuback');
  if (menu) menu.style.visibility = 'visible';
  if (back) back.style.visibility = 'visible';
  setImage(name, 'on');
  setPortal(name);
};
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-menu]').forEach((link) => {
    const name = link.dataset.menu;
    link.addEventListener('click', (event) => { event.preventDefault(); showMenu(name); });
    link.addEventListener('pointerenter', () => { setImage(name, 'on'); setPortal(name); });
    link.addEventListener('pointerleave', () => { setImage(name, 'off'); setPortal(); });
    link.addEventListener('focus', () => showMenu(name));
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideMenus(); });
  menus.forEach((name, index) => setTimeout(() => setImage(name, 'off'), (index + 1) * 500));
});
