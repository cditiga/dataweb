function addRatingStars() {
  const testimonials = document.querySelectorAll('.whatsapp-chat');
  testimonials.forEach(testimonial => {
    const rating = parseInt(testimonial.getAttribute('data-rating'));
    const starsElement = testimonial.querySelector('.stars');
    starsElement.textContent = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  });
}

document.addEventListener('DOMContentLoaded', addRatingStars);