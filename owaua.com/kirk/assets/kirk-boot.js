'use strict';

var drawer = document.getElementById('drawer');
if (drawer && matchMedia('(max-width: 860px)').matches) drawer.open = false;
