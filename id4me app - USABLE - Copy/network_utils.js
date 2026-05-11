function isNetworkFailure(errMsg = "") {
    const msg = (errMsg || "").toLowerCase();
    return [
        "err_internet_disconnected",
        "err_network_changed",
        "err_network_access_denied",
        "err_connection_timed_out",
        "err_connection_reset",
        "err_connection_closed",
        "err_name_not_resolved",
        "err_address_unreachable",
        "err_timed_out",
        "net::err"
    ].some(t => msg.includes(t));
}

module.exports = { isNetworkFailure };
