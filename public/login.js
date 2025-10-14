// public/login.js

// Cek apakah user sudah login
async function checkCurrentUser() {
    try {
        const response = await fetch('/api/current-user');
        if (response.ok) {
            const user = await response.json();
            showUserInfo(user);
            
            // Redirect setelah 2 detik
            setTimeout(() => {
                redirectUser(user);
            }, 2000);
        }
    } catch (error) {
        console.error('Error checking user:', error);
    }
}

function showUserInfo(user) {
    document.getElementById('user-info').style.display = 'block';
    document.getElementById('current-username').textContent = user.name;
    document.getElementById('login-form').style.display = 'none';
}

function redirectUser(user) {
    if (user.role === 'admin') {
        window.location.href = '/admin';
    } else {
        window.location.href = `/line/${user.line}`;
    }
}

// Login function
async function handleLogin(event) {
    event.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message');

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            // Login successful
            if (data.user.role === 'admin') {
                window.location.href = '/admin';
            } else {
                window.location.href = `/line/${data.user.line}`;
            }
        } else {
            errorMessage.textContent = data.error;
            errorMessage.style.display = 'block';
        }
    } catch (error) {
        errorMessage.textContent = 'Login failed. Please try again.';
        errorMessage.style.display = 'block';
    }
}

// Event listener ketika halaman dimuat
document.addEventListener('DOMContentLoaded', function() {
    // Check if user is already logged in
    checkCurrentUser();
    
    // Add event listener untuk form login
    document.getElementById('login-form').addEventListener('submit', handleLogin);
});