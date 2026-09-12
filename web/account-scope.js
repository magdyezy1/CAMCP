'use strict';
// A test account sees only the tabs an evaluator needs. The server refuses the rest outright;
// this keeps the navigation honest so nothing offers a door that will not open.
const testAccountRoutes=['/dashboard','/reporting-overview','/profiles','/connections','/activity','/settings','/account','/privacy','/terms','/data-deletion','/auth/complete','/oauth/consent','/oauth/result'];
const baseScopedRender=render;
render=async function(){
 if(session.authenticated&&session.testAccount){
  document.body.classList.add('test-account');
  for(const link of document.querySelectorAll('[data-route]'))link.hidden=!testAccountRoutes.includes('/'+link.dataset.route);
  if(location.pathname!=='/'&&!testAccountRoutes.includes(location.pathname)&&!location.pathname.startsWith('/login')){
   history.replaceState({},'','/dashboard');
  }
 }else{
  document.body.classList.remove('test-account');
  for(const link of document.querySelectorAll('[data-route]'))link.hidden=false;
 }
 return baseScopedRender.apply(this,arguments);
};
