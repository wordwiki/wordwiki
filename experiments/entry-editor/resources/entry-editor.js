function bindHandlersAfterEachHtmxSettle() {
    document.body.addEventListener('htmx:afterSettle', function(evt) {
        //evt.preventDefault();
        bindHandlers();
    });
}

function bindHandlers() {
    bindEditHandlers();
    bindPopupHandlers();
}

function bindEditHandlers() {
  for (let elem of document.querySelectorAll('.editable .content:not(.bound)')) {
      console.info('binding', elem);
      elem.addEventListener('click', activateEdit);
      elem.classList.add('bound');
  }
}

function activateEdit() {
   const editableContent = event.currentTarget;
   const editable = editableContent.parentElement;
   const dialog = editable.querySelector('dialog');
   if(!dialog) {
       alert('internal error: unable to locate edit dialog');
       return;
   }

   if(!dialog.open)
       dialog.showModal();
}

function bindPopupHandlers() {
  for (let elem of document.querySelectorAll('.popup button:not(.bound)')) {
      console.info('binding button', elem);
      elem.addEventListener('click', activatePopupMenu);
      elem.classList.add('bound');
  }
}

function activatePopupMenu() {
    // If there is an active popup, deactivate it.
    deactivateCurrentPopupMenu();

    // This prevents the window level deactivateCurrentPopupMenu() from deactivating
    // our new popup - but I hate doing this - it is reasonable that there may be
    // other people who care about the click. XXX FIX.
    event.stopPropagation();

    // Activate the current popup
    const buttonElem = event.currentTarget;
    const popupControlElem = buttonElem.parentElement;
    popupControlElem.classList.add('active');
}

function deactivateCurrentPopupMenu() {
   for(let activePopup of document.querySelectorAll('.popup.active')) {
       activePopup.classList.remove('active');
   }
}

// TODO: refactor this to a common place (overwrtiing prop like this is BAD XXX)
window.onclick = deactivateCurrentPopupMenu;

function closeDialog() {
   const form = event.currentTarget;
   const dialog = form.parentElement;
   console.info('dialog', dialog);
   dialog.close();
   console.info('dialog is closed');
   return true;
}


