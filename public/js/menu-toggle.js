document.addEventListener('DOMContentLoaded', function() {
  const menuToggle = document.getElementById('menuToggle');
  const mobileMenuIcon = document.querySelector('.mobile-menu');
  const mobileMenuIconOpen = document.querySelector('.fa-bars');
  const mobileMenuIconClose = document.querySelector('.fa-xmark');
  const tabMenu = document.querySelector('.tab-menu');  
  mobileMenuIcon.addEventListener('click', function(event) {
    event.preventDefault();
    menuToggle.checked = !menuToggle.checked;
    toggleMenu();
  });
  function toggleMenu() {
    if (menuToggle.checked) {
      tabMenu.style.display = 'flex';
      mobileMenuIconOpen.style.display = 'none';
      mobileMenuIconClose.style.display = 'inline-block';
    } else {
      tabMenu.style.display = 'none';
      mobileMenuIconOpen.style.display = 'inline-block';
      mobileMenuIconClose.style.display = 'none';
    }
  }
  // Optional: Hide menu if clicking outside the menu
  document.addEventListener('click', function(event) {
    if (!tabMenu.contains(event.target) && !event.target.closest('.mobile-menu') && menuToggle.checked) {
      menuToggle.checked = false;
      toggleMenu();
    }
  });
  // Adjust menu display on window resize
  window.addEventListener('resize', function() {
    if (window.innerWidth > 768) {
      tabMenu.style.display = 'flex';
      mobileMenuIconOpen.style.display = 'inline-block';
      mobileMenuIconClose.style.display = 'none';
    } else if (!menuToggle.checked) {
      tabMenu.style.display = 'none';
      mobileMenuIconOpen.style.display = 'inline-block';
      mobileMenuIconClose.style.display = 'none';
    }
  });
});