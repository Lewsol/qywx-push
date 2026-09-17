/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        './public/**/*.html',
        './public/**/*.js'
    ],
    theme: {
        extend: {}
    },
    daisyui: {
        themes: ['garden']
    },
    plugins: [require('daisyui')]
};
