function activate_group() {
    const group_elem = event.currentTarget;

    console.info('activate group', group_elem.id);

    const current_active_group_elem = document.querySelector('#annotatedPage svg .group.active');
    if(current_active_group_elem) {
        console.info('deactivating group', current_active_group_elem.id);
        current_active_group_elem.classList.remove('active');
    }
        
    group_elem.classList.add('active');
}

