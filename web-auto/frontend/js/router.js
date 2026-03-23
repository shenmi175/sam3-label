export const router = {
  routes: {},
  currentRoute: null,

  addRoute(path, component) {
    this.routes[path] = component;
  },

  navigate(path) {
    window.location.hash = path;
  },

  init() {
    window.addEventListener('hashchange', this.handleRoute.bind(this));
    this.handleRoute();
  },

  handleRoute() {
    let path = window.location.hash.slice(1) || '/';
    let matchedRoute = null;
    let params = {};

    for (let route in this.routes) {
      if (route === path) {
        matchedRoute = this.routes[route];
        break;
      }
      
      const routeParts = route.split('/');
      const pathParts = path.split('/');
      
      if (routeParts.length === pathParts.length) {
        let match = true;
        let tempParams = {};
        for(let i=0; i < routeParts.length; i++) {
          if (routeParts[i].startsWith(':')) {
            tempParams[routeParts[i].substring(1)] = decodeURIComponent(pathParts[i]);
          } else if (routeParts[i] !== pathParts[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchedRoute = this.routes[route];
          params = tempParams;
          break;
        }
      }
    }

    const appDiv = document.getElementById('app');
    if (matchedRoute) {
      if(this.currentRoute && this.currentRoute.unmount) {
         this.currentRoute.unmount();
      }
      appDiv.innerHTML = '';
      this.currentRoute = matchedRoute;
      matchedRoute.render(appDiv, params);
    } else {
      appDiv.innerHTML = '<div style="padding: 40px; text-align: center;"><h2>404 - Found nothing here</h2><button class="neu-button" onclick="window.location.hash=\'/\'">Go Home</button></div>';
    }
  }
};
