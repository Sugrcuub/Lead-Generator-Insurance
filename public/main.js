document.getElementById('year')?.append(new Date().getFullYear());

window.validateLeadForm = function(form){
  const phone = form.phone.value.trim();
  const email = form.email.value.trim();
  if (!/^[\d\-\+\s\(\)]+$/.test(phone)) {
    alert('Please enter a valid phone number.');
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert('Please enter a valid email address.');
    return false;
  }
  return true;
}
